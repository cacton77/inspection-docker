// EOAT lighting control panel.
//
// Publishes JSON requests on /camera_head/led_ring/request (std_msgs/String).
// lens_tuner on magpi turns each request into a full ring frame with the same
// code the web UI's /api/led and /api/spot use, and stays the ONLY publisher
// of /camera_head/led_ring/command -- this panel never sends frames itself.
//
// Feedback comes from two topics:
//   /camera_head/led_ring/event  outcome of the last request (latched)
//   /camera_head/led_ring/state  what the hardware is actually showing. This is
//     ground truth: a joystick override, homing or a capture can legitimately
//     differ from what was requested.

import { Immutable, MessageEvent, PanelExtensionContext } from "@foxglove/extension";
import {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

const REQUEST_TOPIC = "/camera_head/led_ring/request";
const EVENT_TOPIC = "/camera_head/led_ring/event";
const STATE_TOPIC = "/camera_head/led_ring/state";
const SEND_INTERVAL_MS = 150; // max request rate while dragging (~6/s)
const STATE_STALE_MS = 2000; // firmware publishes state at 10 Hz

// Ring geometry, mirroring inspection_eoat/ring_spot.py. Index 0 of every ring
// points down; with ring_clockwise=false (lens_tuner's default) index advances
// counter-clockwise in a frame with x right, y up.
const RINGS = [
  { name: "inner", count: 16, radius: 52 },
  { name: "mid", count: 24, radius: 72 },
  { name: "outer", count: 32, radius: 92 },
] as const;
// Matches lens_tuner's ring_clockwise parameter (default false).
const RING_CLOCKWISE = false;
const SIGMA_MIN_MM = Math.round(0.5 * ((2 * Math.PI * 52) / 16) * 10) / 10; // ~10.2
const SIGMA_MAX_MM = 40;

type RingName = (typeof RINGS)[number]["name"];
type Mode = "solid" | "rings" | "spot";

type PanelState = {
  mode: Mode;
  solidColor: string;
  solidBrightness: number; // 0..100 %
  ringColors: Record<RingName, string>;
  ringEnabled: Record<RingName, boolean>;
  ringBrightness: number;
  spot: { x: number; y: number; sigma: number; amplitude: number; color: string };
  live: boolean; // send while dragging, rather than only on release/Apply
};

const DEFAULT_STATE: PanelState = {
  mode: "solid",
  solidColor: "#ffffff",
  solidBrightness: 30,
  ringColors: { inner: "#ffffff", mid: "#ffffff", outer: "#ffffff" },
  ringEnabled: { inner: true, mid: true, outer: true },
  ringBrightness: 30,
  spot: { x: 0, y: 0, sigma: 20, amplitude: 0.05, color: "#ffffff" },
  live: true,
};

const PIXEL_POSITIONS: [number, number][] = (() => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const sign = RING_CLOCKWISE ? -1 : 1;
  const out: [number, number][] = [];
  for (const ring of RINGS) {
    for (let i = 0; i < ring.count; i++) {
      const theta = -Math.PI / 2 + sign * ((2 * Math.PI * i) / ring.count);
      out.push([ring.radius * Math.cos(theta), ring.radius * Math.sin(theta)]);
    }
  }
  return out;
})();

function scaleColor(hex: string, percent: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const f = Math.max(0, Math.min(100, percent)) / 100;
  const r = Math.round(((v >> 16) & 0xff) * f);
  const g = Math.round(((v >> 8) & 0xff) * f);
  const b = Math.round((v & 0xff) * f);
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

function packedToCss(c: number): string {
  return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
}

function buildRequest(s: PanelState): Record<string, unknown> {
  switch (s.mode) {
    case "solid":
      return { mode: "solid", color: scaleColor(s.solidColor, s.solidBrightness) };
    case "rings": {
      const req: Record<string, unknown> = { mode: "rings" };
      for (const ring of RINGS) {
        req[ring.name] = s.ringEnabled[ring.name]
          ? scaleColor(s.ringColors[ring.name], s.ringBrightness)
          : "#000000";
      }
      return req;
    }
    case "spot":
      return { mode: "spot", ...s.spot };
  }
}

type EventMsg = { ok: boolean; message: string; time?: number };

function LightingPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [state, setState] = useState<PanelState>(() => ({
    ...DEFAULT_STATE,
    ...((context.initialState as Partial<PanelState> | undefined) ?? {}),
  }));
  const [shown, setShown] = useState<number[] | undefined>();
  const [shownAt, setShownAt] = useState(0);
  const [event, setEvent] = useState<EventMsg | undefined>();
  const [sendError, setSendError] = useState<string | undefined>();
  const [now, setNow] = useState(Date.now());
  const [dark, setDark] = useState(true);
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  const canPublish = context.publish != undefined && context.advertise != undefined;

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.colorScheme) {
        setDark(renderState.colorScheme === "dark");
      }
      for (const ev of (renderState.currentFrame ?? []) as Immutable<MessageEvent[]>) {
        if (ev.topic === STATE_TOPIC) {
          const msg = ev.message as { colors?: ArrayLike<number> };
          setShown(Array.from(msg.colors ?? []));
          setShownAt(Date.now());
        } else if (ev.topic === EVENT_TOPIC) {
          try {
            setEvent(JSON.parse((ev.message as { data: string }).data) as EventMsg);
          } catch {
            // ignore malformed event
          }
        }
      }
    };
    context.watch("currentFrame");
    context.watch("colorScheme");
    context.subscribe([{ topic: STATE_TOPIC }, { topic: EVENT_TOPIC }]);
    context.advertise?.(REQUEST_TOPIC, "std_msgs/msg/String");
    return () => {
      context.unadvertise?.(REQUEST_TOPIC);
    };
  }, [context]);

  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // Tick so the "stale" indicator updates even when no messages arrive.
  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); }, 500);
    return () => { clearInterval(id); };
  }, []);

  useEffect(() => {
    context.saveState(state);
  }, [context, state]);

  // --- sending, throttled with a guaranteed trailing send -------------------
  const lastSent = useRef(0);
  const pending = useRef<Record<string, unknown> | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>();

  const sendNow = useCallback(
    (req: Record<string, unknown>) => {
      if (!context.publish) {
        return;
      }
      try {
        context.publish(REQUEST_TOPIC, { data: JSON.stringify(req) });
        lastSent.current = Date.now();
        setSendError(undefined);
      } catch (e) {
        setSendError(String(e));
      }
    },
    [context],
  );

  const send = useCallback(
    (req: Record<string, unknown>) => {
      pending.current = req;
      const wait = SEND_INTERVAL_MS - (Date.now() - lastSent.current);
      if (wait <= 0) {
        clearTimeout(timer.current);
        timer.current = undefined;
        pending.current = undefined;
        sendNow(req);
      } else {
        timer.current ??= setTimeout(() => {
          timer.current = undefined;
          if (pending.current) {
            const r = pending.current;
            pending.current = undefined;
            sendNow(r);
          }
        }, wait);
      }
    },
    [sendNow],
  );

  useEffect(() => () => { clearTimeout(timer.current); }, []);

  // Update state; with live on, also send the resulting request. A ref holds
  // the latest state so the send happens here, not inside a setState updater.
  const stateRef = useRef(state);
  const update = useCallback(
    (patch: (s: PanelState) => PanelState, opts?: { forceSend?: boolean }) => {
      const next = patch(stateRef.current);
      stateRef.current = next;
      setState(next);
      if (next.live || opts?.forceSend === true) {
        send(buildRequest(next));
      }
    },
    [send],
  );

  // --- styles ----------------------------------------------------------------
  const fg = dark ? "#e6e6e6" : "#1a1a1a";
  const muted = dark ? "#9a9a9a" : "#666";
  const border = dark ? "#3a3a3a" : "#ccc";
  const accent = "#4f8cff";
  const btn = ({ active }: { active: boolean }): CSSProperties => ({
    padding: "4px 10px",
    border: `1px solid ${active ? accent : border}`,
    background: active ? accent : "transparent",
    color: active ? "#fff" : fg,
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
  });
  const row: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "70px 1fr 56px",
    alignItems: "center",
    gap: 8,
    margin: "4px 0",
  };

  const stale = now - shownAt > STATE_STALE_MS;

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    fmt: (v: number) => string = (v) => String(v),
  ): ReactElement => (
    <div style={row}>
      <span style={{ color: muted }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => { onChange(Number(e.target.value)); }}
        style={{ width: "100%" }}
      />
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(value)}</span>
    </div>
  );

  // --- ring preview ------------------------------------------------------------
  const R = 104; // view radius, mm
  const onPreviewClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (state.mode !== "spot") {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 * R - R;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 * R - R);
    update((s) => ({ ...s, spot: { ...s.spot, x: Math.round(x), y: Math.round(y) } }), { forceSend: true });
  };

  const preview = (
    <svg
      viewBox={`${-R} ${-R} ${2 * R} ${2 * R}`}
      style={{
        width: "100%",
        maxWidth: 220,
        aspectRatio: "1",
        cursor: state.mode === "spot" ? "crosshair" : "default",
        display: "block",
      }}
      onClick={onPreviewClick}
    >
      <circle r={R - 2} fill={dark ? "#111" : "#f2f2f2"} stroke={border} />
      {PIXEL_POSITIONS.map(([x, y], i) => {
        const c = shown?.[i] ?? 0;
        return (
          <circle
            key={i}
            cx={x}
            cy={-y}
            r={5}
            fill={stale || c === 0 ? "transparent" : packedToCss(c)}
            stroke={stale ? border : c === 0 ? border : packedToCss(c)}
            strokeWidth={1}
          />
        );
      })}
      {state.mode === "spot" && (
        <g>
          <circle
            cx={state.spot.x}
            cy={-state.spot.y}
            r={state.spot.sigma}
            fill="none"
            stroke={accent}
            strokeDasharray="3 3"
          />
          <circle cx={state.spot.x} cy={-state.spot.y} r={2.5} fill={accent} />
        </g>
      )}
      {/* index 0 marker (down) */}
      <text x={0} y={R - 4} fontSize={8} textAnchor="middle" fill={muted}>
        0
      </text>
    </svg>
  );

  const lit = shown ? shown.filter((c) => c !== 0).length : 0;

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
      {!canPublish && (
        <div style={{ color: "#e5534b", marginBottom: 8 }}>
          This connection doesn&apos;t allow publishing. Connect to the lab bridge (ws://pop-os:8765)
          with clientPublish enabled.
        </div>
      )}

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button
          style={{ ...btn({ active: false }), borderColor: "#e5534b", color: "#e5534b", fontWeight: 600 }}
          onClick={() => { sendNow({ mode: "off" }); }}
          disabled={!canPublish}
          title="Turn the whole ring off"
        >
          Off
        </button>
        <span style={{ width: 8 }} />
        {(["solid", "rings", "spot"] as Mode[]).map((m) => (
          <button
            key={m}
            style={btn({ active: state.mode === m })}
            onClick={() => { update((s) => ({ ...s, mode: m })); }}
          >
            {m[0]!.toUpperCase() + m.slice(1)}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <label style={{ color: muted, fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={state.live}
            onChange={(e) => {
              const next = { ...stateRef.current, live: e.target.checked };
              stateRef.current = next;
              setState(next);
            }}
          />
          live
        </label>
        {!state.live && (
          <button
            style={btn({ active: true })}
            disabled={!canPublish}
            onClick={() => { sendNow(buildRequest(state)); }}
          >
            Apply
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 200 }}>
          {state.mode === "solid" && (
            <>
              <div style={row}>
                <span style={{ color: muted }}>colour</span>
                <input
                  type="color"
                  value={state.solidColor}
                  onChange={(e) => { update((s) => ({ ...s, solidColor: e.target.value })); }}
                />
                <span />
              </div>
              {slider("brightness", state.solidBrightness, 0, 100, 1, (v) => { update((s) => ({ ...s, solidBrightness: v })); }, (v) => `${v}%`)}
            </>
          )}

          {state.mode === "rings" && (
            <>
              {RINGS.map((ring) => (
                <div style={row} key={ring.name}>
                  <label style={{ color: muted, display: "flex", gap: 4, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={state.ringEnabled[ring.name]}
                      onChange={(e) => { update((s) => ({
                          ...s,
                          ringEnabled: { ...s.ringEnabled, [ring.name]: e.target.checked },
                        })); }
                      }
                    />
                    {ring.name}
                  </label>
                  <input
                    type="color"
                    value={state.ringColors[ring.name]}
                    onChange={(e) => { update((s) => ({
                        ...s,
                        ringColors: { ...s.ringColors, [ring.name]: e.target.value },
                      })); }
                    }
                  />
                  <span style={{ color: muted, fontSize: 11 }}>{ring.count} px</span>
                </div>
              ))}
              {slider("brightness", state.ringBrightness, 0, 100, 1, (v) => { update((s) => ({ ...s, ringBrightness: v })); }, (v) => `${v}%`)}
            </>
          )}

          {state.mode === "spot" && (
            <>
              {slider("x (mm)", state.spot.x, -92, 92, 1, (v) => { update((s) => ({ ...s, spot: { ...s.spot, x: v } })); })}
              {slider("y (mm)", state.spot.y, -92, 92, 1, (v) => { update((s) => ({ ...s, spot: { ...s.spot, y: v } })); })}
              {slider("σ (mm)", state.spot.sigma, SIGMA_MIN_MM, SIGMA_MAX_MM, 0.5, (v) => { update((s) => ({ ...s, spot: { ...s.spot, sigma: v } })); })}
              {slider("flux", state.spot.amplitude, 0, 1, 0.005, (v) => { update((s) => ({ ...s, spot: { ...s.spot, amplitude: v } })); }, (v) => v.toFixed(3))}
              <div style={row}>
                <span style={{ color: muted }}>colour</span>
                <input
                  type="color"
                  value={state.spot.color}
                  onChange={(e) => { update((s) => ({ ...s, spot: { ...s.spot, color: e.target.value } })); }
                  }
                />
                <span />
              </div>
              <div style={{ color: muted, fontSize: 11, marginTop: 4 }}>
                Click the ring to place the spot. Flux is total light (1 = every pixel at full),
                so narrowing σ concentrates it rather than dimming it.
              </div>
            </>
          )}
        </div>

        <div style={{ flex: "0 1 220px" }}>
          {preview}
          <div style={{ color: muted, fontSize: 11, textAlign: "center", marginTop: 2 }}>
            {stale ? "no /led_ring/state (stale)" : `hardware: ${lit}/${shown?.length ?? 0} lit`}
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 10,
          paddingTop: 6,
          borderTop: `1px solid ${border}`,
          fontSize: 12,
          color: sendError || event?.ok === false ? "#e5534b" : muted,
          wordBreak: "break-word",
        }}
      >
        {sendError
          ? `publish failed: ${sendError}`
          : event
            ? `${event.ok ? "✓" : "✗"} ${event.message}`
            : "no response yet from lens_tuner"}
      </div>
    </div>
  );
}

export function initLightingPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<LightingPanel context={context} />);
  return () => {
    root.unmount();
  };
}
