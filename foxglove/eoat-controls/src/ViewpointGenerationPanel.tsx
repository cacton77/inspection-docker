// Viewpoint-generation control panel: the Foxglove counterpart of the Open3D
// GUI's pipeline controls, used next to a 3D panel.
//
// The geometry itself is drawn by Foxglove's 3D panel from the topics that
// viewpoint_generation's foxglove_viz node publishes (/viewpoint_generation/viz/*).
// This panel:
//   * shows the latched ~/summary (stage, counts, imaging modes, warnings);
//   * runs the pipeline stages, which are std_srvs/Trigger services on
//     /viewpoint_generation, through the lab bridge's service whitelist;
//   * steps through regions and clusters, publishing {region, cluster} on
//     ~/select. The viz node then highlights them on ~/selection and
//     ~/selection_points, and moves the viewpoint_generation/selected_viewpoint
//     TF frame to the selected camera pose.

import { Immutable, MessageEvent, PanelExtensionContext } from "@foxglove/extension";
import {
  CSSProperties,
  ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

const PREFIX = "/viewpoint_generation/viz";
const SUMMARY_TOPIC = `${PREFIX}/summary`;
const SELECT_TOPIC = `${PREFIX}/select`;
const STAGE_SERVICE = "/viewpoint_generation";

type RegionSummary = {
  id: number;
  faces: number;
  points: number;
  clusters: number;
  viewpoints: number;
  blind_spots: number;
  color: string;
  cluster_ids?: number[];
};

type Summary = {
  results_file: string;
  mesh_file: string;
  stage: string;
  triangles: number;
  regions: RegionSummary[];
  num_clusters: number;
  num_viewpoints: number;
  imaging_modes: Record<string, number>;
  blind_spots: number;
  noise_faces: number;
  camera_config: Record<string, number>;
  warnings: string[];
};

const STAGES: { service: string; label: string; needs: string[] }[] = [
  { service: "segment_regions", label: "Segment", needs: ["mesh", "segmented", "clustered", "projected", "optimized"] },
  { service: "fov_clustering", label: "FOV cluster", needs: ["segmented", "clustered", "projected", "optimized"] },
  { service: "viewpoint_projection", label: "Project", needs: ["clustered", "projected", "optimized"] },
  { service: "optimize_traversal", label: "Optimize path", needs: ["projected", "optimized"] },
];
const STAGE_ORDER = ["", "mesh", "segmented", "clustered", "projected", "optimized"];
const MODE_COLOR: Record<string, string> = {
  photometric: "#1ad933",
  standard: "#ffd91a",
  inaccessible: "#ff1a1a",
};

type PanelState = { region: number; cluster: number }; // -1 = none

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function ViewpointGenerationPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [summary, setSummary] = useState<Summary | undefined>();
  const [sel, setSel] = useState<PanelState>(() => ({
    region: -1,
    cluster: -1,
    ...((context.initialState as Partial<PanelState> | undefined) ?? {}),
  }));
  const [busy, setBusy] = useState<string | undefined>();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | undefined>();
  const [dark, setDark] = useState(true);
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  const canCall = context.callService != undefined;
  const canPublish = context.publish != undefined && context.advertise != undefined;

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.colorScheme) {
        setDark(renderState.colorScheme === "dark");
      }
      for (const ev of (renderState.currentFrame ?? []) as Immutable<MessageEvent[]>) {
        if (ev.topic === SUMMARY_TOPIC) {
          try {
            setSummary(JSON.parse((ev.message as { data: string }).data) as Summary);
          } catch {
            // ignore malformed summary
          }
        }
      }
    };
    context.watch("currentFrame");
    context.watch("colorScheme");
    context.subscribe([{ topic: SUMMARY_TOPIC }]);
    context.advertise?.(SELECT_TOPIC, "std_msgs/msg/String");
    return () => {
      context.unadvertise?.(SELECT_TOPIC);
    };
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  useEffect(() => {
    context.saveState(sel);
  }, [context, sel]);

  // Publish the selection whenever it changes (and once the summary arrives,
  // so a reloaded layout re-applies its saved selection).
  useEffect(() => {
    if (!canPublish || summary == undefined) {
      return;
    }
    try {
      context.publish?.(SELECT_TOPIC, { data: JSON.stringify({ region: sel.region, cluster: sel.cluster }) });
    } catch (e) {
      setNotice({ ok: false, text: `select: ${String(e)}` });
    }
  }, [context, canPublish, sel, summary]);

  const runStage = useCallback(
    async (service: string, label: string) => {
      if (!context.callService) {
        return;
      }
      setBusy(`${label}…`);
      setNotice(undefined);
      try {
        const res = (await context.callService(`${STAGE_SERVICE}/${service}`, {})) as {
          success: boolean;
          message: string;
        };
        setNotice({ ok: res.success, text: `${label}: ${res.message}` });
      } catch (e) {
        setNotice({ ok: false, text: `${label}: ${String(e)}` });
      } finally {
        setBusy(undefined);
      }
    },
    [context],
  );

  // --- derived ---------------------------------------------------------------------
  const regions = summary?.regions ?? [];
  const region = regions.find((r) => r.id === sel.region);
  const clusterIds = region?.cluster_ids ?? [];
  const clusterPos = clusterIds.indexOf(sel.cluster);
  const stageIdx = STAGE_ORDER.indexOf(summary?.stage ?? "");

  const stepRegion = (delta: number) => {
    if (regions.length === 0) {
      return;
    }
    const i = regions.findIndex((r) => r.id === sel.region);
    const next = i < 0 ? (delta > 0 ? 0 : regions.length - 1) : (i + delta + regions.length) % regions.length;
    setSel({ region: regions[next]!.id, cluster: -1 });
  };
  const stepCluster = (delta: number) => {
    if (clusterIds.length === 0) {
      return;
    }
    const next = clusterPos < 0 ? (delta > 0 ? 0 : clusterIds.length - 1) : (clusterPos + delta + clusterIds.length) % clusterIds.length;
    setSel((s) => ({ ...s, cluster: clusterIds[next]! }));
  };

  // --- styles ------------------------------------------------------------------------
  const fg = dark ? "#e6e6e6" : "#1a1a1a";
  const muted = dark ? "#9a9a9a" : "#666";
  const border = dark ? "#3a3a3a" : "#ccc";
  const accent = "#4f8cff";
  const red = "#e5534b";
  const btn = ({ primary = false }: { primary?: boolean } = {}): CSSProperties => ({
    padding: "4px 10px",
    border: `1px solid ${primary ? accent : border}`,
    background: primary ? accent : "transparent",
    color: primary ? "#fff" : fg,
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
    whiteSpace: "nowrap",
  });
  const section: CSSProperties = { marginTop: 10, paddingTop: 8, borderTop: `1px solid ${border}` };
  const num: CSSProperties = { fontVariantNumeric: "tabular-nums" };
  const swatch = (c: string): CSSProperties => ({
    display: "inline-block",
    width: 10,
    height: 10,
    borderRadius: 2,
    background: c,
    marginRight: 6,
    verticalAlign: "middle",
  });

  return (
    <div
      style={{
        padding: 10,
        color: fg,
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        height: "100%",
        overflowY: "auto",
        boxSizing: "border-box",
      }}
    >
      {/* plan summary */}
      {summary ? (
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong style={{ textTransform: "capitalize" }}>{summary.stage || "empty"}</strong>
            <span style={{ color: muted, fontSize: 12, wordBreak: "break-all" }} title={summary.results_file}>
              {basename(summary.results_file || summary.mesh_file) || "no plan loaded"}
            </span>
          </div>
          <div style={{ ...num, color: muted, fontSize: 12, marginTop: 2 }}>
            {summary.triangles} triangles · {regions.length} regions · {summary.num_clusters} clusters ·{" "}
            {summary.num_viewpoints} viewpoints
            {summary.blind_spots > 0 && <span style={{ color: "#ff40ff" }}> · {summary.blind_spots} blind-spot pts</span>}
          </div>
          {Object.keys(summary.imaging_modes).length > 0 && (
            <div style={{ fontSize: 12, marginTop: 2 }}>
              {Object.entries(summary.imaging_modes).map(([m, n]) => (
                <span key={m} style={{ marginRight: 10 }}>
                  <span style={swatch(MODE_COLOR[m] ?? muted)} />
                  {m} {n}
                </span>
              ))}
            </div>
          )}
          {summary.warnings.length > 0 && (
            <details style={{ color: "#d29922", fontSize: 11, marginTop: 4 }}>
              <summary style={{ cursor: "pointer" }}>{summary.warnings.length} warning(s)</summary>
              {summary.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </details>
          )}
        </div>
      ) : (
        <div style={{ color: muted }}>
          Waiting for {SUMMARY_TOPIC}. Is the foxglove_viz node running (bringup foxglove_viz:=true)?
        </div>
      )}

      {/* stages */}
      <div style={section}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STAGES.map((s, i) => {
            const ready = summary != undefined && s.needs.includes(summary.stage);
            const done = stageIdx >= i + 2;
            return (
              <button
                key={s.service}
                style={btn({ primary: ready && !done })}
                disabled={!canCall || busy != undefined || !ready}
                onClick={() => { void runStage(s.service, s.label); }}
                title={`/viewpoint_generation/${s.service}${done ? " (re-run)" : ""}`}
              >
                {done ? "↻ " : ""}
                {s.label}
              </button>
            );
          })}
        </div>
        {!canCall && (
          <div style={{ color: red, fontSize: 11, marginTop: 4 }}>
            This connection doesn&apos;t allow service calls; connect to ws://pop-os:8765.
          </div>
        )}
        {(busy != undefined || notice != undefined) && (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: busy != undefined ? accent : notice?.ok === true ? muted : red,
              wordBreak: "break-all",
            }}
          >
            {busy ?? (notice ? `${notice.ok ? "✓" : "✗"} ${notice.text}` : "")}
          </div>
        )}
      </div>

      {/* selection */}
      <div style={section}>
        <div style={{ display: "grid", gridTemplateColumns: "60px auto 1fr", gap: 6, alignItems: "center" }}>
          <span style={{ color: muted }}>region</span>
          <span style={{ display: "flex", gap: 4 }}>
            <button style={btn()} disabled={regions.length === 0} onClick={() => { stepRegion(-1); }}>
              ◀
            </button>
            <button style={btn()} disabled={regions.length === 0} onClick={() => { stepRegion(1); }}>
              ▶
            </button>
          </span>
          <span style={num}>
            {region ? (
              <>
                <span style={swatch(region.color)} />R{region.id} · {region.faces} faces · {region.clusters} clusters
                {region.blind_spots > 0 ? ` · ${region.blind_spots} blind` : ""}
              </>
            ) : (
              <span style={{ color: muted }}>none</span>
            )}
          </span>

          <span style={{ color: muted }}>cluster</span>
          <span style={{ display: "flex", gap: 4 }}>
            <button style={btn()} disabled={clusterIds.length === 0} onClick={() => { stepCluster(-1); }}>
              ◀
            </button>
            <button style={btn()} disabled={clusterIds.length === 0} onClick={() => { stepCluster(1); }}>
              ▶
            </button>
          </span>
          <span style={num}>
            {clusterPos >= 0 ? (
              `#${clusterPos + 1} of ${clusterIds.length} (id ${sel.cluster})`
            ) : (
              <span style={{ color: muted }}>{clusterIds.length > 0 ? `none (${clusterIds.length})` : "none"}</span>
            )}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button style={btn()} onClick={() => { setSel({ region: -1, cluster: -1 }); }}>
            Clear selection
          </button>
        </div>
      </div>

      {/* region table */}
      {regions.length > 0 && (
        <div style={section}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, ...num }}>
            <thead>
              <tr style={{ color: muted, textAlign: "right" }}>
                <th style={{ textAlign: "left" }}>region</th>
                <th>faces</th>
                <th>points</th>
                <th>clusters</th>
                <th>vps</th>
                <th>blind</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => { setSel({ region: r.id, cluster: -1 }); }}
                  style={{
                    cursor: "pointer",
                    textAlign: "right",
                    background: r.id === sel.region ? (dark ? "#1f3a66" : "#dbe7ff") : "transparent",
                  }}
                >
                  <td style={{ textAlign: "left" }}>
                    <span style={swatch(r.color)} />R{r.id}
                  </td>
                  <td>{r.faces}</td>
                  <td>{r.points}</td>
                  <td>{r.clusters}</td>
                  <td>{r.viewpoints}</td>
                  <td style={{ color: r.blind_spots > 0 ? "#ff40ff" : undefined }}>{r.blind_spots}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function initViewpointGenerationPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<ViewpointGenerationPanel context={context} />);
  return () => {
    root.unmount();
  };
}
