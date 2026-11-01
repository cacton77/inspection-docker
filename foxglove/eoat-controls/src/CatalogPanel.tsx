// PLM part catalog panel (plm_bridge).
//
// The Foxglove counterpart of plm_bridge's browser picker, over ROS instead of
// HTTP: it calls the /catalog/* services through the lab's foxglove_bridge,
// which whitelists exactly list_backends, list_parts, select_part, sync_now
// and ensure_plan. Selecting a part goes through /catalog/select_part, which
// fetches the STEP, resolves the plan and publishes /catalog/part_selected,
// the same path the web picker's Select button takes.
//
// Thumbnails are the one thing ROS does not carry. They are loaded as plain
// <img> tags from the picker's /thumb/<storage_key> route when that host is
// reachable (it is over Tailscale), and simply omitted when it is not.
//
// Not here, still in the web picker: plan history, loading an older plan,
// adopting plan files, uploading plans, run history.

import { Immutable, MessageEvent, PanelExtensionContext } from "@foxglove/extension";
import {
  CSSProperties,
  ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

const NS = "/catalog";
const SELECTED_TOPIC = `${NS}/part_selected`;
const SYNC_TOPIC = `${NS}/sync_complete`;

type PartSummary = {
  backend: string;
  part_id: string;
  title: string;
  part_number: string;
  revision: string;
  maturity: string;
  container: string;
  sync_status: string;
  geometry_cached: boolean;
  geometry_available: boolean;
  geometry_path: string;
  thumbnail_path: string;
  plan_status: string;
  last_synced: string;
};

type BackendInfo = { name: string; capabilities: string[]; connected: boolean; message: string };

type SyncResult = {
  backend: string;
  success: boolean;
  added: number;
  modified: number;
  unchanged: number;
  archived: number;
  errors: number;
  duration_sec: number;
  message: string;
};

type PartSelected = {
  backend: string;
  part_id: string;
  title: string;
  part_number: string;
  revision: string;
  geometry_path: string;
  plan_status: string;
  plan_file_path: string;
};

type PanelState = {
  search: string;
  maturity: string;
  includeArchived: boolean;
  pickerUrl: string; // for thumbnails only; '' disables them
};

const DEFAULT_STATE: PanelState = {
  search: "",
  maturity: "",
  includeArchived: false,
  pickerUrl: "http://pop-os:5050",
};

type Notice = { ok: boolean; text: string };

// Mirrors the picker's card_state() as far as PartSummary allows (it has no
// geometry token, so "stale geometry" cannot be told apart from "ready").
function cardState(p: PartSummary): { key: string; label: string; color: string } {
  if (p.sync_status === "archived") {
    return { key: "archived", label: "Archived", color: "#8b949e" };
  }
  if (p.geometry_cached) {
    return { key: "ready", label: "Ready", color: "#3fb950" };
  }
  if (p.geometry_available) {
    return { key: "fetch", label: "Fetch", color: "#4f8cff" };
  }
  if (p.sync_status === "new") {
    return { key: "new", label: "New", color: "#a371f7" };
  }
  return { key: "nostp", label: "No STP", color: "#d29922" };
}

const PLAN_COLOR: Record<string, string> = {
  CURRENT: "#3fb950",
  DOWNLOADED: "#3fb950",
  UPDATED_FROM_REMOTE: "#4f8cff",
  SELECTED: "#d29922",
  STALE: "#e5534b",
  NONE: "#8b949e",
};

// plm_bridge.core.paths.storage_key(): f"{backend}-{sha1(part_id)[:16]}".
async function storageKey(backend: string, partId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(partId));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${backend}-${hex.slice(0, 16)}`;
}

function partKey(p: { backend: string; part_id: string }): string {
  return `${p.backend}\u0000${p.part_id}`;
}

function Thumb({ url, size, border }: { url?: string; size: number; border: string }): ReactElement {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  const box: CSSProperties = {
    width: size,
    height: size,
    flex: `0 0 ${size}px`,
    borderRadius: 4,
    border: `1px solid ${border}`,
    objectFit: "contain",
    background: "#0000",
  };
  if (url == undefined || failed) {
    return <div style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, opacity: 0.5 }}>no image</div>;
  }
  return <img src={url} style={box} onError={() => { setFailed(true); }} alt="" />;
}

function CatalogPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [state, setState] = useState<PanelState>(() => ({
    ...DEFAULT_STATE,
    ...((context.initialState as Partial<PanelState> | undefined) ?? {}),
  }));
  const [parts, setParts] = useState<PartSummary[]>([]);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [selected, setSelected] = useState<PartSelected | undefined>();
  const [focus, setFocus] = useState<string | undefined>(); // partKey of the detail view
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | undefined>(); // what is running
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [dark, setDark] = useState(true);
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const [showSettings, setShowSettings] = useState(false);

  const canCall = context.callService != undefined;

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.colorScheme) {
        setDark(renderState.colorScheme === "dark");
      }
      for (const ev of (renderState.currentFrame ?? []) as Immutable<MessageEvent[]>) {
        if (ev.topic === SELECTED_TOPIC) {
          setSelected({ ...(ev.message as PartSelected) });
        } else if (ev.topic === SYNC_TOPIC) {
          const r = ev.message as SyncResult;
          setNotice({
            ok: r.success,
            text: `${r.backend} sync: ${r.message || (r.success ? "done" : "failed")}`,
          });
          setRefreshTick((t) => t + 1);
        }
      }
    };
    context.watch("currentFrame");
    context.watch("colorScheme");
    context.subscribe([{ topic: SELECTED_TOPIC }, { topic: SYNC_TOPIC }]);
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  useEffect(() => {
    context.saveState(state);
  }, [context, state]);

  const call = useCallback(
    async <T,>(name: string, request: Record<string, unknown>): Promise<T> => {
      if (!context.callService) {
        throw new Error("this connection does not support service calls");
      }
      return (await context.callService(`${NS}/${name}`, request)) as T;
    },
    [context],
  );

  // --- data ----------------------------------------------------------------------
  const [refreshTick, setRefreshTick] = useState(0);
  const [searchDebounced, setSearchDebounced] = useState(state.search);
  useEffect(() => {
    const id = setTimeout(() => { setSearchDebounced(state.search); }, 300);
    return () => { clearTimeout(id); };
  }, [state.search]);

  const loadBackends = useCallback(async () => {
    try {
      const res = await call<{ backends: BackendInfo[] }>("list_backends", {});
      setBackends(Array.from(res.backends));
    } catch (e) {
      setNotice({ ok: false, text: `list_backends: ${String(e)}` });
    }
  }, [call]);

  const requestSeq = useRef(0);
  useEffect(() => {
    if (!canCall) {
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    call<{ parts: PartSummary[]; total_count: number }>("list_parts", {
      backend: "",
      filter: searchDebounced,
      maturity_filter: state.maturity,
      include_archived: state.includeArchived,
    })
      .then((res) => {
        if (seq === requestSeq.current) {
          setParts(Array.from(res.parts).map((p) => ({ ...p })));
        }
      })
      .catch((e: unknown) => {
        if (seq === requestSeq.current) {
          setNotice({ ok: false, text: `list_parts: ${String(e)}` });
        }
      })
      .finally(() => {
        if (seq === requestSeq.current) {
          setLoading(false);
        }
      });
  }, [call, canCall, searchDebounced, state.maturity, state.includeArchived, refreshTick]);

  useEffect(() => {
    if (canCall) {
      void loadBackends();
    }
  }, [canCall, loadBackends, refreshTick]);

  // Thumbnail URLs need the storage key, which is a SHA-1: async, so cached.
  useEffect(() => {
    if (state.pickerUrl === "") {
      return;
    }
    const run = { cancelled: false };
    void (async () => {
      const next: Record<string, string> = {};
      for (const p of parts) {
        if (p.thumbnail_path !== "") {
          next[partKey(p)] = `${state.pickerUrl.replace(/\/$/, "")}/thumb/${await storageKey(p.backend, p.part_id)}`;
        }
      }
      if (!run.cancelled) {
        setThumbs(next);
      }
    })();
    return () => { run.cancelled = true; };
  }, [parts, state.pickerUrl]);

  // Maturity options come from what the catalog actually contains.
  const [maturities, setMaturities] = useState<string[]>([]);
  useEffect(() => {
    setMaturities((prev) => {
      const all = new Set([...prev, ...parts.map((p) => p.maturity).filter((m) => m !== "")]);
      return Array.from(all).sort();
    });
  }, [parts]);

  // --- actions -------------------------------------------------------------------
  const selectPart = useCallback(
    async (p: PartSummary, { modelOnly }: { modelOnly: boolean }) => {
      setBusy(`${modelOnly ? "Loading model" : "Selecting"} ${p.title}…`);
      setNotice(undefined);
      try {
        const res = await call<{
          success: boolean;
          geometry_path: string;
          plan_status: string;
          error_message: string;
        }>("select_part", { backend: p.backend, part_id: p.part_id, skip_plan_check: modelOnly });
        setNotice(
          res.success
            ? { ok: true, text: `Selected ${p.title}: plan ${res.plan_status || "NONE"} · ${res.geometry_path}` }
            : { ok: false, text: res.error_message || "select_part failed" },
        );
        setRefreshTick((t) => t + 1);
      } catch (e) {
        setNotice({ ok: false, text: `select_part: ${String(e)}` });
      } finally {
        setBusy(undefined);
      }
    },
    [call],
  );

  const checkPlan = useCallback(
    async (p: PartSummary) => {
      setBusy(`Checking plan for ${p.title}…`);
      try {
        const res = await call<{ status: string; plan_file_path: string; message: string }>(
          "ensure_plan",
          { backend: p.backend, part_id: p.part_id },
        );
        setNotice({
          ok: res.status !== "STALE",
          text: `Plan ${res.status}${res.plan_file_path ? ` · ${res.plan_file_path}` : ""}${res.message ? ` · ${res.message}` : ""}`,
        });
        setRefreshTick((t) => t + 1);
      } catch (e) {
        setNotice({ ok: false, text: `ensure_plan: ${String(e)}` });
      } finally {
        setBusy(undefined);
      }
    },
    [call],
  );

  const sync = useCallback(
    async ({ full }: { full: boolean }) => {
      setBusy(`${full ? "Full" : "Incremental"} sync…`);
      setNotice(undefined);
      try {
        const res = await call<{ results: SyncResult[] }>("sync_now", { backend: "", full });
        const results = Array.from(res.results);
        const ok = results.length > 0 && results.every((r) => r.success);
        const text = results
          .map((r) =>
            r.success
              ? `${r.backend}: +${r.added} ~${r.modified} =${r.unchanged} archived ${r.archived}` +
                (r.errors > 0 ? `, ${r.errors} errors` : "") + ` (${r.duration_sec.toFixed(1)} s)`
              : `${r.backend || "sync"}: ${r.message}`,
          )
          .join("; ");
        setNotice({ ok, text: text || "sync produced no result" });
        setRefreshTick((t) => t + 1);
      } catch (e) {
        setNotice({ ok: false, text: `sync_now: ${String(e)}` });
      } finally {
        setBusy(undefined);
      }
    },
    [call],
  );

  // --- styles --------------------------------------------------------------------
  const fg = dark ? "#e6e6e6" : "#1a1a1a";
  const muted = dark ? "#9a9a9a" : "#666";
  const border = dark ? "#3a3a3a" : "#ccc";
  const cardBg = dark ? "#1b1b1b" : "#fafafa";
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
  const pill = (color: string): CSSProperties => ({
    padding: "0 6px",
    borderRadius: 8,
    border: `1px solid ${color}`,
    color,
    fontSize: 10,
    fontWeight: 600,
    whiteSpace: "nowrap",
  });
  const input: CSSProperties = {
    background: "transparent",
    color: fg,
    border: `1px solid ${border}`,
    borderRadius: 4,
    padding: "3px 6px",
    fontSize: 12,
  };

  const focused = useMemo(() => parts.find((p) => partKey(p) === focus), [parts, focus]);
  const selectedKey = selected ? partKey(selected) : undefined;
  const disabled = !canCall || busy != undefined;

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
      {!canCall && (
        <div style={{ color: red, marginBottom: 8 }}>
          This connection doesn&apos;t allow service calls. Connect to the lab bridge
          (ws://pop-os:8765), which offers the /catalog/* services.
        </div>
      )}

      {/* backends + sync */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {backends.map((b) => (
          <span
            key={b.name}
            style={pill(b.connected ? "#3fb950" : "#d29922")}
            title={b.message || (b.connected ? "connected" : "not connected")}
          >
            {b.name} {b.connected ? "connected" : "offline"}
          </span>
        ))}
        {backends.length === 0 && <span style={{ color: muted, fontSize: 12 }}>no backends reported</span>}
        <span style={{ flex: 1 }} />
        <button style={btn()} disabled={disabled} onClick={() => { void sync({ full: false }); }} title="Incremental sync">
          Sync
        </button>
        <button style={btn()} disabled={disabled} onClick={() => { void sync({ full: true }); }} title="Full reconcile with the PLM">
          Full sync
        </button>
        <button style={btn()} disabled={!canCall} onClick={() => { setRefreshTick((t) => t + 1); }} title="Reload the list">
          ↻
        </button>
        <button style={btn()} onClick={() => { setShowSettings((s) => !s); }} title="Panel settings">
          ⚙
        </button>
      </div>
      {backends.some((b) => !b.connected && b.message !== "") && (
        <div style={{ color: "#d29922", fontSize: 11, marginTop: 4 }}>
          {backends.filter((b) => !b.connected).map((b) => `${b.name}: ${b.message}`).join(" · ")}
          {" "}Cached parts still browse and select.
        </div>
      )}

      {showSettings && (
        <div style={{ marginTop: 8, fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: muted }}>Thumbnails from</span>
          <input
            style={{ ...input, flex: 1 }}
            value={state.pickerUrl}
            placeholder="http://pop-os:5050 (empty = no thumbnails)"
            onChange={(e) => { setState((s) => ({ ...s, pickerUrl: e.target.value.trim() })); }}
          />
        </div>
      )}

      {/* current selection */}
      <div
        style={{
          marginTop: 8,
          padding: "6px 8px",
          border: `1px solid ${border}`,
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        {selected ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: muted }}>Loaded:</span>
            <strong>{selected.title || selected.part_id}</strong>
            {selected.part_number !== "" && (
              <span style={{ color: muted }}>
                {selected.part_number}
                {selected.revision !== "" ? ` rev ${selected.revision}` : ""}
              </span>
            )}
            <span style={pill(PLAN_COLOR[selected.plan_status] ?? muted)}>plan {selected.plan_status || "NONE"}</span>
            <span style={{ color: muted, wordBreak: "break-all", width: "100%" }} title={selected.plan_file_path}>
              {selected.geometry_path}
            </span>
          </div>
        ) : (
          <span style={{ color: muted }}>No part selected yet (/catalog/part_selected).</span>
        )}
      </div>

      {/* filters */}
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          style={{ ...input, flex: "1 1 160px" }}
          placeholder="Search title, part number, description"
          value={state.search}
          onChange={(e) => { setState((s) => ({ ...s, search: e.target.value })); }}
        />
        <select
          style={input}
          value={state.maturity}
          onChange={(e) => { setState((s) => ({ ...s, maturity: e.target.value })); }}
        >
          <option value="">all maturities</option>
          {maturities.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <label style={{ color: muted, fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={state.includeArchived}
            onChange={(e) => { setState((s) => ({ ...s, includeArchived: e.target.checked })); }}
          />
          archived
        </label>
        <span style={{ color: muted, fontSize: 12 }}>
          {loading ? "loading…" : `${parts.length} part${parts.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* detail */}
      {focused && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            border: `1px solid ${accent}`,
            borderRadius: 6,
            display: "flex",
            gap: 10,
          }}
        >
          <Thumb url={thumbs[partKey(focused)]} size={96} border={border} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <strong style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{focused.title || "(untitled)"}</strong>
              <span style={{ flex: 1 }} />
              <button style={{ ...btn(), padding: "0 6px" }} onClick={() => { setFocus(undefined); }}>
                ✕
              </button>
            </div>
            <div style={{ color: muted, fontSize: 12 }}>
              {[focused.part_number, focused.revision && `rev ${focused.revision}`, focused.maturity, focused.container, focused.backend]
                .filter((x) => x !== "")
                .join(" · ")}
            </div>
            <div style={{ display: "flex", gap: 6, margin: "4px 0", flexWrap: "wrap" }}>
              <span style={pill(cardState(focused).color)}>{cardState(focused).label}</span>
              <span style={pill(PLAN_COLOR[focused.plan_status] ?? muted)}>plan {focused.plan_status || "NONE"}</span>
              <span style={{ color: muted, fontSize: 11 }}>
                synced {focused.last_synced !== "" ? focused.last_synced.replace("T", " ").replace("Z", " UTC") : "never"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              <button
                style={btn({ primary: true })}
                disabled={disabled || cardState(focused).key === "nostp"}
                onClick={() => { void selectPart(focused, { modelOnly: false }); }}
                title="Fetch the STEP if needed, resolve the inspection plan, and load it"
              >
                Select
              </button>
              <button
                style={btn()}
                disabled={disabled || cardState(focused).key === "nostp"}
                onClick={() => { void selectPart(focused, { modelOnly: true }); }}
                title="Load the geometry only, without resolving a plan"
              >
                Model only
              </button>
              <button
                style={btn()}
                disabled={disabled}
                onClick={() => { void checkPlan(focused); }}
                title="Check the plan against the PLM (may download a newer one)"
              >
                Check plan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* status line */}
      {(busy != undefined || notice != undefined) && (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: busy != undefined ? accent : notice?.ok === true ? muted : red,
            wordBreak: "break-word",
          }}
        >
          {busy ?? (notice ? `${notice.ok ? "✓" : "✗"} ${notice.text}` : "")}
        </div>
      )}

      {/* grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: 8,
          marginTop: 8,
        }}
      >
        {parts.map((p) => {
          const k = partKey(p);
          const st = cardState(p);
          const isSel = k === selectedKey;
          return (
            <div
              key={k}
              onClick={() => { setFocus(k); }}
              onDoubleClick={() => {
                if (!disabled && st.key !== "nostp") {
                  void selectPart(p, { modelOnly: false });
                }
              }}
              title="Click for actions; double-click to select"
              style={{
                display: "flex",
                gap: 8,
                padding: 6,
                borderRadius: 6,
                cursor: "pointer",
                background: cardBg,
                border: `1px solid ${isSel ? "#3fb950" : k === focus ? accent : border}`,
                opacity: st.key === "archived" ? 0.6 : 1,
              }}
            >
              <Thumb url={thumbs[k]} size={56} border={border} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.title || "(untitled)"}
                </div>
                <div style={{ color: muted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.part_number}
                  {p.revision !== "" ? ` · ${p.revision}` : ""}
                  {p.maturity !== "" ? ` · ${p.maturity}` : ""}
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
                  <span style={pill(st.color)}>{st.label}</span>
                  {p.plan_status !== "" && p.plan_status !== "NONE" && (
                    <span style={pill(PLAN_COLOR[p.plan_status] ?? muted)}>{p.plan_status}</span>
                  )}
                  {isSel && <span style={pill("#3fb950")}>loaded</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {!loading && parts.length === 0 && canCall && (
        <div style={{ color: muted, marginTop: 12 }}>No parts match.</div>
      )}
    </div>
  );
}

export function initCatalogPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<CatalogPanel context={context} />);
  return () => {
    root.unmount();
  };
}
