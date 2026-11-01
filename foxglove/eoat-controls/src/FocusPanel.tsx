// EOAT focus-stage (lens stepper) control panel.
//
// Publishes JSON requests on /camera_head/lens/request (std_msgs/String).
// lens_tuner on magpi handles them with the same code as its web UI and stays
// the ONLY publisher of /camera_head/lens/command, so this panel never streams
// motor commands itself.
//
// Safety model:
//   * Hold-to-move sends {"op":"velocity"} and re-sends it every KEEPALIVE_MS.
//     lens_tuner drops a hold 0.6 s after the last refresh, so if this panel,
//     the app, or the network goes away mid-hold the lens stops by itself.
//     Releasing (or losing pointer capture, or the window losing focus) sends
//     an explicit stop straight away.
//   * Step jogs are bounded by a step budget that lens_tuner enforces from
//     /lens/state, not by this panel.
//   * Go-to sends one MODE_POSITION seek; the firmware clamps it to the
//     calibrated range. STOP cancels it.
//
// Feedback:
//   /camera_head/lens/state  ps_interfaces/LensState at 20 Hz from the firmware
//   /camera_head/lens/event  outcome of the last request (latched)

import { Immutable, MessageEvent, PanelExtensionContext } from "@foxglove/extension";
import {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

const REQUEST_TOPIC = "/camera_head/lens/request";
const EVENT_TOPIC = "/camera_head/lens/event";
const STATE_TOPIC = "/camera_head/lens/state";
// lens_tuner's hold_timeout is 600 ms; 150 ms gives four tries per window,
// which tolerates the odd delayed packet over Tailscale.
const KEEPALIVE_MS = 150;
const STATE_STALE_MS = 1000; // firmware publishes at 20 Hz
const MAX_VELOCITY = 3000; // lens_tuner's max_velocity clamp
const MAX_BUDGET = 4000; // lens_tuner's max_step_budget clamp

const STATUS = ["UNCALIBRATED", "IDLE", "MOVING", "STALLED", "HOMING"] as const;
const STATUS_COLOR = ["#d29922", "#3fb950", "#4f8cff", "#e5534b", "#a371f7"];

type LensState = {
  position_norm: number;
  velocity: number;
  status: number;
  steps: number;
  sg_result: number;
  driver_ok: boolean;
  driver_enabled: boolean;
};

type PanelState = {
  speed: number; // steps/s for hold and step jogs
  budget: number; // steps per step jog
  target: number; // 0..1 go-to target
};

const DEFAULT_STATE: PanelState = { speed: 400, budget: 200, target: 0.5 };

type EventMsg = { ok: boolean; message: string; time?: number };

function FocusPanel({ context }: { context: PanelExtensionContext }): ReactElement {
  const [state, setState] = useState<PanelState>(() => ({
    ...DEFAULT_STATE,
    ...((context.initialState as Partial<PanelState> | undefined) ?? {}),
  }));
  const [lens, setLens] = useState<LensState | undefined>();
  const [lensAt, setLensAt] = useState(0);
  const [event, setEvent] = useState<EventMsg | undefined>();
  const [sendError, setSendError] = useState<string | undefined>();
  const [now, setNow] = useState(Date.now());
  const [dark, setDark] = useState(true);
  const [holding, setHolding] = useState(0); // signed velocity being held, 0 = none
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();

  const canPublish = context.publish != undefined && context.advertise != undefined;

  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      if (renderState.colorScheme) {
        setDark(renderState.colorScheme === "dark");
      }
      const frame = (renderState.currentFrame ?? []) as Immutable<MessageEvent[]>;
      let latest: LensState | undefined;
      for (const ev of frame) {
        if (ev.topic === STATE_TOPIC) {
          latest = ev.message as LensState;
        } else if (ev.topic === EVENT_TOPIC) {
          try {
            setEvent(JSON.parse((ev.message as { data: string }).data) as EventMsg);
          } catch {
            // ignore malformed event
          }
        }
      }
      if (latest) {
        setLens({ ...latest });
        setLensAt(Date.now());
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

  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); }, 250);
    return () => { clearInterval(id); };
  }, []);

  useEffect(() => {
    context.saveState(state);
  }, [context, state]);

  const send = useCallback(
    (req: Record<string, unknown>) => {
      if (!context.publish) {
        return;
      }
      try {
        context.publish(REQUEST_TOPIC, { data: JSON.stringify(req) });
        setSendError(undefined);
      } catch (e) {
        setSendError(String(e));
      }
    },
    [context],
  );

  // --- hold-to-move ------------------------------------------------------------
  const keepalive = useRef<ReturnType<typeof setInterval> | undefined>();
  const holdingRef = useRef(0);

  const endHold = useCallback(() => {
    clearInterval(keepalive.current);
    keepalive.current = undefined;
    if (holdingRef.current !== 0) {
      holdingRef.current = 0;
      setHolding(0);
      send({ op: "stop" });
    }
  }, [send]);

  const startHold = useCallback(
    (velocity: number) => {
      clearInterval(keepalive.current);
      holdingRef.current = velocity;
      setHolding(velocity);
      send({ op: "velocity", velocity });
      keepalive.current = setInterval(() => {
        send({ op: "velocity", velocity: holdingRef.current });
      }, KEEPALIVE_MS);
    },
    [send],
  );

  // Stop on window blur / tab hide (a release we would otherwise never see) and
  // on unmount.
  useEffect(() => {
    const onHide = () => { endHold(); };
    window.addEventListener("blur", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("blur", onHide);
      document.removeEventListener("visibilitychange", onHide);
      endHold();
    };
  }, [endHold]);

  const stopAll = useCallback(() => {
    clearInterval(keepalive.current);
    keepalive.current = undefined;
    holdingRef.current = 0;
    setHolding(0);
    send({ op: "stop" });
  }, [send]);

  // --- derived -----------------------------------------------------------------
  const stale = now - lensAt > STATE_STALE_MS;
  const calibrated = lens != undefined && Number.isFinite(lens.position_norm);
  const homing = lens?.status === 4;
  const statusName = lens ? (STATUS[lens.status] ?? `?${lens.status}`) : "—";
  const statusColor = lens && !stale ? (STATUS_COLOR[lens.status] ?? "#888") : "#888";
  const disabled = !canPublish || homing;

  // --- styles ------------------------------------------------------------------
  const fg = dark ? "#e6e6e6" : "#1a1a1a";
  const muted = dark ? "#9a9a9a" : "#666";
  const border = dark ? "#3a3a3a" : "#ccc";
  const accent = "#4f8cff";
  const red = "#e5534b";
  const btn = ({ active = false }: { active?: boolean } = {}): CSSProperties => ({
    padding: "6px 10px",
    border: `1px solid ${active ? accent : border}`,
    background: active ? accent : "transparent",
    color: active ? "#fff" : fg,
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
    userSelect: "none",
    touchAction: "none",
  });
  const row: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "70px 1fr 64px",
    alignItems: "center",
    gap: 8,
    margin: "4px 0",
  };
  const kv: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8 };
  const num: CSSProperties = { fontVariantNumeric: "tabular-nums" };
  const section: CSSProperties = { marginTop: 10, paddingTop: 8, borderTop: `1px solid ${border}` };

  const holdButton = (label: string, sign: number, factor: number, title: string): ReactElement => {
    const v = sign * Math.round(state.speed * factor);
    const active = holding !== 0 && holding === v;
    return (
      <button
        style={{ ...btn({ active }), flex: 1 }}
        disabled={disabled}
        title={title}
        onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          startHold(v);
        }}
        onPointerUp={endHold}
        onPointerCancel={endHold}
        onLostPointerCapture={endHold}
        onContextMenu={(e) => { e.preventDefault(); }}
      >
        {label}
      </button>
    );
  };

  const posPct = calibrated ? Math.max(0, Math.min(1, lens.position_norm)) * 100 : undefined;

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
        <div style={{ color: red, marginBottom: 8 }}>
          This connection doesn&apos;t allow publishing. Connect to the lab bridge (ws://pop-os:8765)
          with clientPublish enabled.
        </div>
      )}

      {/* status + STOP */}
      <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
        <button
          style={{
            ...btn(),
            borderColor: red,
            background: red,
            color: "#fff",
            fontWeight: 700,
            fontSize: 14,
            padding: "8px 16px",
          }}
          disabled={!canPublish}
          onClick={stopAll}
          title="Stop any jog, hold or seek"
        >
          STOP
        </button>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                padding: "1px 8px",
                borderRadius: 10,
                border: `1px solid ${statusColor}`,
                color: statusColor,
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {stale ? "NO STATE" : statusName}
            </span>
            <span style={{ ...num, color: muted, fontSize: 12 }}>
              {lens ? `${lens.steps} steps · ${lens.velocity.toFixed(0)} steps/s` : "waiting for /lens/state"}
            </span>
          </div>
          {lens && !stale && (
            <div style={{ fontSize: 11, color: lens.driver_ok ? muted : "#d29922" }}>
              {lens.driver_ok
                ? `driver ${lens.driver_enabled ? "energised" : "idle (no holding torque)"} · SG ${lens.sg_result}`
                : "TMC2209 not answering over UART: no StallGuard, no homing"}
            </div>
          )}
        </div>
      </div>

      {/* position bar */}
      <div style={{ marginTop: 10 }}>
        <div
          style={{
            position: "relative",
            height: 14,
            borderRadius: 7,
            border: `1px solid ${border}`,
            background: dark ? "#111" : "#f2f2f2",
          }}
          title={calibrated ? "calibrated range, min → max" : "no calibrated range"}
        >
          {calibrated && (
            <div
              style={{
                position: "absolute",
                left: `${state.target * 100}%`,
                top: -2,
                bottom: -2,
                width: 0,
                borderLeft: `1px dashed ${muted}`,
              }}
            />
          )}
          {posPct != undefined && (
            <div
              style={{
                position: "absolute",
                left: `calc(${posPct}% - 6px)`,
                top: 0,
                width: 12,
                height: 12,
                borderRadius: 6,
                background: stale ? muted : accent,
              }}
            />
          )}
        </div>
        <div style={{ ...kv, fontSize: 11, color: muted, marginTop: 2 }}>
          <span>min</span>
          <span style={num}>{calibrated ? `position ${lens.position_norm.toFixed(3)}` : "uncalibrated"}</span>
          <span>max</span>
        </div>
      </div>

      {/* hold to move */}
      <div style={section}>
        <div style={{ color: muted, fontSize: 12, marginBottom: 4 }}>Hold to move</div>
        <div style={{ display: "flex", gap: 6 }}>
          {holdButton("◀◀", -1, 1, "Hold: toward min at full speed")}
          {holdButton("◀", -1, 0.2, "Hold: toward min at 20% speed")}
          {holdButton("▶", 1, 0.2, "Hold: toward max at 20% speed")}
          {holdButton("▶▶", 1, 1, "Hold: toward max at full speed")}
        </div>
        <div style={row}>
          <span style={{ color: muted }}>speed</span>
          <input
            type="range"
            min={50}
            max={MAX_VELOCITY}
            step={50}
            value={state.speed}
            onChange={(e) => { setState((s) => ({ ...s, speed: Number(e.target.value) })); }}
          />
          <span style={{ ...num, textAlign: "right" }}>{state.speed}/s</span>
        </div>
      </div>

      {/* step jog */}
      <div style={section}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            style={{ ...btn(), flex: 1 }}
            disabled={disabled}
            onClick={() => { send({ op: "jog", velocity: -state.speed, budget: state.budget }); }}
          >
            − {state.budget} steps
          </button>
          <input
            type="number"
            min={1}
            max={MAX_BUDGET}
            step={10}
            value={state.budget}
            onChange={(e) => {
              const raw = Math.round(Number(e.target.value));
              const v = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_BUDGET, raw)) : 1;
              setState((s) => ({ ...s, budget: v }));
            }}
            style={{ width: 70, ...num }}
            title="Steps per jog (lens_tuner caps it at 4000)"
          />
          <button
            style={{ ...btn(), flex: 1 }}
            disabled={disabled}
            onClick={() => { send({ op: "jog", velocity: state.speed, budget: state.budget }); }}
          >
            + {state.budget} steps
          </button>
        </div>
      </div>

      {/* go to */}
      <div style={section}>
        <div style={row}>
          <span style={{ color: calibrated ? muted : border }}>go to</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={state.target}
            disabled={!calibrated}
            onChange={(e) => { setState((s) => ({ ...s, target: Number(e.target.value) })); }}
          />
          <button
            style={btn({ active: true })}
            disabled={disabled || !calibrated}
            onClick={() => { send({ op: "goto", position: state.target }); }}
          >
            Go {state.target.toFixed(3)}
          </button>
        </div>
        {!calibrated && (
          <div style={{ color: muted, fontSize: 11 }}>
            Go-to needs a calibrated range (set MIN and MAX below).
          </div>
        )}
      </div>

      {/* calibration */}
      <details style={section}>
        <summary style={{ cursor: "pointer", color: muted, fontSize: 12 }}>Range calibration</summary>
        <div style={{ color: muted, fontSize: 11, margin: "6px 0" }}>
          Jog to the minimum and set it (it becomes step 0 and clears the max). Then jog to the
          maximum, back off a little, and set that. The firmware then clamps every move to the
          range.
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            style={{ ...btn(), flex: 1 }}
            disabled={disabled}
            onClick={() => {
              if (window.confirm(`Set MIN at step ${lens?.steps ?? "?"}?\n\nThis becomes step 0 and clears the max.`)) {
                send({ op: "set_min" });
              }
            }}
          >
            Set MIN here
          </button>
          <button
            style={{ ...btn(), flex: 1 }}
            disabled={disabled}
            onClick={() => {
              if (window.confirm(`Set MAX at step ${lens?.steps ?? "?"}?`)) {
                send({ op: "set_max" });
              }
            }}
          >
            Set MAX here
          </button>
        </div>
      </details>

      <div
        style={{
          ...section,
          fontSize: 12,
          color: sendError || event?.ok === false ? red : muted,
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

export function initFocusPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<FocusPanel context={context} />);
  return () => {
    root.unmount();
  };
}
