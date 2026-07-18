import { VFC } from "react";
import { DialogButton, ToggleField, Focusable } from "decky-frontend-lib";
import { CurvePoint } from "../util";
import { Stepper } from "./inputs";

// Temperature axis bounds for the graph / sliders.
export const T_MIN = 30;
export const T_MAX = 95;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function sortPoints(pts: CurvePoint[]): CurvePoint[] {
  return [...pts].sort((a, b) => a.temp - b.temp);
}

// Sort and collapse duplicate temperatures (last one wins) so the curve the
// backend receives never has two points at the same temp (a zero-width segment).
// Use this when persisting/applying a curve, not while editing.
export function normalizePoints(pts: CurvePoint[]): CurvePoint[] {
  const byTemp = new Map<number, CurvePoint>();
  for (const p of sortPoints(pts)) byTemp.set(p.temp, p);
  return Array.from(byTemp.values()).sort((a, b) => a.temp - b.temp);
}

// Read-only SVG plot of the curve with an optional live marker at the current
// temperature (green dashed line).
export const CurveGraph: VFC<{ points: CurvePoint[]; maxRpm: number; tempC?: number | null; rpm?: number | null }> = ({
  points,
  maxRpm,
  tempC,
  rpm,
}) => {
  const W = 300;
  const H = 130;
  // Left/bottom gutters are widened to hold the axis tick labels below.
  const padL = 26, padR = 8, padT = 8, padB = 16;
  // Clamp both axes. The editor's Steppers keep live edits in range, but this
  // graph also renders saved profiles and the backend's live curve, neither of
  // which is guaranteed to fit: a curve authored against an OLED's higher RPM
  // ceiling rendered on an LCD, or a hand-edited config.json (the file is
  // advertised as human-editable) with a point below 30°C or above 95°C, would
  // otherwise map outside the plot box. The root <svg> clips to its viewport, so
  // an off-range point would vanish entirely and a polyline to a far-off vertex
  // would distort the visible line. Clamping pins it to the frame edge, which
  // reads as "past the end" far better than a dot floating loose.
  const x = (t: number) =>
    padL + ((clamp(t, T_MIN, T_MAX) - T_MIN) / (T_MAX - T_MIN)) * (W - padL - padR);
  const y = (r: number) =>
    padT + (1 - clamp(r, 0, maxRpm) / Math.max(1, maxRpm)) * (H - padT - padB);
  const pts = sortPoints(points);
  const line = pts.map((p) => `${x(p.temp).toFixed(1)},${y(p.rpm).toFixed(1)}`).join(" ");
  // tempC is live hardware, wholly unrelated to the axis bounds — a docked Deck
  // idles below the 30°C floor and can spike past 95°C — so the marker is the
  // most likely thing to escape the plot. Clamp it too.
  const haveTemp = typeof tempC === "number";
  const haveRpm = typeof rpm === "number";
  const markerX = haveTemp ? x(tempC as number) : 0;
  // The green dashed marker is the live operating point. The legend doubles as a
  // readout: it only renders when there's a real current temperature to mark
  // (saved-profile editing passes none), names the green line as "now", and
  // shows the live temp — and the RPM too when the backend reports it.
  const nowLabel = haveTemp
    ? "Now " + Math.round(tempC as number) + "°" + (haveRpm ? " · " + Math.round(rpm as number) + " rpm" : "")
    : "";
  // Character-count width estimate. It's approximate in a proportional font, but
  // the legend is now RIGHT-aligned, so this drives POSITION as well as the plate
  // width -- an underestimate would push it off the right edge. Bias the per-char
  // figure up slightly (5.5) and pad the base so the estimate errs wide, keeping
  // the whole plate inside the plot rather than clipped at the frame.
  const legendW = 26 + nowLabel.length * 5.5;
  // Pinned top-RIGHT, not top-left. The green temp marker sits at markerX, and a
  // docked Deck idling below 30°C clamps markerX to exactly padL (the left edge)
  // -- so a top-left legend would sit directly under the marker in the common
  // idle-docked case, hiding the very "now" values it's meant to show. The
  // right corner is clear of both the idle marker and a cold-start first point.
  const legendX = W - padR - legendW;
  // Axis reference ticks so the plot is legible on its own, not just via the
  // Steppers below: fan speed up the left edge (0 → max), temperature along the
  // bottom (T_MIN → T_MAX). maxRpm differs by panel (LCD vs OLED), so the RPM
  // labels are derived from it rather than hard-coded; compact "k" form keeps the
  // left gutter narrow. The mid RPM tick sits on the centre gridline.
  const rpmMax = Math.max(1, maxRpm);
  const fmtRpm = (v: number) => (v >= 1000 ? +(v / 1000).toFixed(1) + "k" : String(Math.round(v)));
  const gridY = (g: number) => padT + g * (H - padT - padB);
  const rpmTicks = [
    { y: padT, v: rpmMax, base: "hanging" },
    { y: gridY(0.5), v: rpmMax / 2, base: "middle" },
    { y: H - padB, v: 0, base: "middle" },
  ];
  const tempTicks = [
    { t: T_MIN, anchor: "start" },
    { t: 60, anchor: "middle" },
    { t: T_MAX, anchor: "end" },
  ];
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ background: "rgba(255,255,255,0.04)", borderRadius: "6px" }}>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={"h" + g} x1={padL} x2={W - padR} y1={gridY(g)} y2={gridY(g)}
          stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      ))}
      {tempTicks.map((tk) => (
        <line key={"v" + tk.t} x1={x(tk.t)} x2={x(tk.t)} y1={padT} y2={H - padB}
          stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      ))}
      {rpmTicks.map((tk, i) => (
        <text key={"ry" + i} x={padL - 4} y={tk.y} textAnchor="end" dominantBaseline={tk.base as any}
          fontSize={9} fill="rgba(255,255,255,0.5)">{fmtRpm(tk.v)}</text>
      ))}
      {tempTicks.map((tk) => (
        <text key={"tt" + tk.t} x={x(tk.t)} y={H - padB + 11} textAnchor={tk.anchor as any}
          fontSize={9} fill="rgba(255,255,255,0.5)">{tk.t + "°"}</text>
      ))}
      {pts.length >= 2 ? (
        <polyline points={line} fill="none" stroke="#5b7cf0" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      ) : null}
      {pts.map((p, i) => (
        <circle key={i} cx={x(p.temp)} cy={y(p.rpm)} r="3.5" fill="#f1f4fa" />
      ))}
      {haveTemp ? (
        <line x1={markerX} x2={markerX} y1={padT} y2={H - padB}
          stroke="#52d669" strokeWidth="1.5" strokeDasharray="3 3" />
      ) : null}
      {haveTemp && haveRpm ? (
        <circle cx={markerX} cy={y(rpm as number)} r="3" fill="#52d669" stroke="#0b0f16" strokeWidth="1" />
      ) : null}
      {haveTemp ? (
        <g>
          <rect x={legendX} y={padT + 1} width={legendW} height={12} rx={2} fill="rgba(11,15,22,0.6)" />
          <line x1={legendX + 4} x2={legendX + 16} y1={padT + 7} y2={padT + 7}
            stroke="#52d669" strokeWidth="1.5" strokeDasharray="3 3" />
          <text x={legendX + 20} y={padT + 7} dominantBaseline="middle" fontSize={9} fill="#7fe89a">{nowLabel}</text>
        </g>
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
  rpm?: number | null;
  busy?: boolean;
  onPoints: (p: CurvePoint[]) => void;
  onInterpolate: (b: boolean) => void;
}> = ({ points, interpolate, maxRpm, tempC, rpm, busy, onPoints, onInterpolate }) => {
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
    // Already at the max temperature — adding here would stack a duplicate temp
    // (a degenerate curve point). Bail instead; the add button is also disabled.
    if (last && temp <= last.temp) return;
    // rpmSeed, not rpm: the component destructures a `rpm` prop (the live
    // reading) and shadowing it here would mislead the next editor of addPoint.
    const rpmSeed = last ? Math.min(maxRpm, last.rpm + 1000) : 3000;
    onPoints([...points, { temp, rpm: rpmSeed }]);
  }
  const atMaxTemp = points.length > 0 && Math.max(...points.map((p) => p.temp)) >= T_MAX;

  return (
    <div>
      <CurveGraph points={points} maxRpm={maxRpm} tempC={tempC} rpm={rpm} />
      <ToggleField
        label="Smooth (interpolate between points)"
        checked={interpolate}
        onChange={onInterpolate}
      />
      <div style={{ fontWeight: 600, margin: "8px 0 2px" }}>Curve points</div>
      {points.length < 2 ? (
        <div style={{ opacity: 0.6, margin: "4px 0" }}>Add at least two points to define a curve.</div>
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
        <DialogButton disabled={busy || atMaxTemp} onClick={addPoint}>+ Add point</DialogButton>
      </Focusable>
    </div>
  );
};
