import { VFC } from "react";
import { DialogButton, ToggleField, Focusable } from "decky-frontend-lib";
import { CurvePoint } from "../util";
import { Stepper } from "./inputs";

// Temperature axis bounds for the graph / sliders.
export const T_MIN = 30;
export const T_MAX = 95;

export function sortPoints(pts: CurvePoint[]): CurvePoint[] {
  return [...pts].sort((a, b) => a.temp - b.temp);
}

// Read-only SVG plot of the curve with an optional live marker at the current
// temperature (green dashed line).
export const CurveGraph: VFC<{ points: CurvePoint[]; maxRpm: number; tempC?: number | null }> = ({
  points,
  maxRpm,
  tempC,
}) => {
  const W = 300;
  const H = 130;
  const padL = 4, padR = 4, padT = 6, padB = 6;
  const x = (t: number) => padL + ((t - T_MIN) / (T_MAX - T_MIN)) * (W - padL - padR);
  const y = (r: number) => padT + (1 - r / maxRpm) * (H - padT - padB);
  const pts = sortPoints(points);
  const line = pts.map((p) => `${x(p.temp).toFixed(1)},${y(p.rpm).toFixed(1)}`).join(" ");
  const haveTemp = typeof tempC === "number";
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: "rgba(255,255,255,0.04)", borderRadius: "6px" }}>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={padL} x2={W - padR} y1={padT + g * (H - padT - padB)} y2={padT + g * (H - padT - padB)}
          stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      ))}
      {pts.length >= 2 ? (
        <polyline points={line} fill="none" stroke="#5b7cf0" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      ) : null}
      {pts.map((p, i) => (
        <circle key={i} cx={x(p.temp)} cy={y(p.rpm)} r="3.5" fill="#f1f4fa" />
      ))}
      {haveTemp ? (
        <line x1={x(tempC as number)} x2={x(tempC as number)} y1={padT} y2={H - padB}
          stroke="#52d669" strokeWidth="1.5" strokeDasharray="3 3" />
      ) : null}
    </svg>
  );
};

// Controlled editor for a fan curve: graph + interpolate toggle + per-point
// temperature/RPM sliders with add/remove. Used for the live active curve and
// for each saved profile.
export const CurveEditor: VFC<{
  points: CurvePoint[];
  interpolate: boolean;
  maxRpm: number;
  tempC?: number | null;
  busy?: boolean;
  onPoints: (p: CurvePoint[]) => void;
  onInterpolate: (b: boolean) => void;
}> = ({ points, interpolate, maxRpm, tempC, busy, onPoints, onInterpolate }) => {
  function setPoint(i: number, key: "temp" | "rpm", val: number) {
    onPoints(points.map((p, j) => (j === i ? { ...p, [key]: val } : p)));
  }
  function removePoint(i: number) {
    onPoints(points.filter((_, j) => j !== i));
  }
  function addPoint() {
    const sorted = sortPoints(points);
    const last = sorted[sorted.length - 1];
    const temp = last ? Math.min(T_MAX, last.temp + 10) : 60;
    const rpm = last ? Math.min(maxRpm, last.rpm + 1000) : 3000;
    onPoints([...points, { temp, rpm }]);
  }

  return (
    <div>
      <CurveGraph points={points} maxRpm={maxRpm} tempC={tempC} />
      <ToggleField
        label="Smooth (interpolate between points)"
        checked={interpolate}
        onChange={onInterpolate}
      />
      <div style={{ fontWeight: 600, margin: "8px 0 2px" }}>Curve points</div>
      {points.length === 0 ? (
        <div style={{ opacity: 0.6, margin: "4px 0" }}>No points yet — add at least two.</div>
      ) : null}
      {points.map((p, i) => (
        <div
          key={i}
          style={{
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: "6px",
            padding: "6px 10px",
            marginBottom: "8px",
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <Stepper label="Temperature °C" value={p.temp} min={T_MIN} max={T_MAX} step={1} coarse={5} unit="°C"
            disabled={busy} onChange={(v) => setPoint(i, "temp", v)} />
          <Stepper label="Fan RPM" value={p.rpm} min={0} max={maxRpm} step={100} coarse={1000}
            disabled={busy} onChange={(v) => setPoint(i, "rpm", v)} />
          <DialogButton style={{ marginTop: "4px" }} disabled={busy} onClick={() => removePoint(i)}>
            Remove point
          </DialogButton>
        </div>
      ))}
      <Focusable flow-children="horizontal" style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
        <DialogButton disabled={busy} onClick={addPoint}>+ Add point</DialogButton>
      </Focusable>
    </div>
  );
};
