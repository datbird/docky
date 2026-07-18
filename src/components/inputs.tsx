import { VFC } from "react";
import { Field, TextField, DialogButton, Focusable } from "decky-frontend-lib";

// A bordered card wrapping one editable Action or Mode.
export const Card: VFC<{ title: string; children: any }> = ({ title, children }) => (
  <div
    style={{
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: "6px",
      padding: "8px 12px",
      marginBottom: "10px",
      background: "rgba(255,255,255,0.03)",
    }}
  >
    <div style={{ fontWeight: 600, marginBottom: "4px" }}>{title}</div>
    {children}
  </div>
);

export const TextRow: VFC<{ label: string; value?: string; password?: boolean; onChange: (v: string) => void }> = (props) => {
  // NOTE: verify `bIsPassword` is the masking prop in THIS build of the injected
  // decky-frontend-lib. It's cast through `any`, so a wrong name (e.g. the field
  // wants type="password") fails silently -- the input renders in plaintext with
  // no type error. The only caller that relies on masking is PairModal; if a
  // password ever shows unmasked, this is the first place to look.
  const extra: any = props.password ? { bIsPassword: true } : {};
  return (
    <Field label={props.label} childrenLayout="below" bottomSeparator="none">
      <TextField {...extra} value={props.value || ""} onChange={(e) => props.onChange(e.target.value)} />
    </Field>
  );
};

// A numeric stepper built only from DialogButton/Field/Focusable (all present in
// the runtime decky-frontend-lib global). Used instead of DFL's SliderField,
// which isn't exposed by the injected DFL global (rendering it crashes the panel
// with React #130). Optional `coarse` adds «/» buttons for big jumps.
export const Stepper: VFC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  coarse?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, coarse, unit, disabled, onChange }) => {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  // Everything below derives from this clamped value, never the raw `value`
  // prop, which isn't validated -- a stored out-of-range value (e.g. a TDP
  // profile persisted at 2W when min is 3) would otherwise paint the unreachable
  // number while the −/« buttons sit disabled at the bound and the +/» buttons
  // fire a no-op first press. Clamping once keeps the readout, the enable/disable
  // bounds, and the emitted value consistent from the first paint.
  const shown = clamp(value);
  // A plain render helper, NOT an inline component. Defining a component inside
  // Stepper would give it a new type identity every render, so React would
  // unmount/remount the buttons on each value change and GamepadUI would drop
  // focus mid-press. Returning <DialogButton> elements keeps the type stable.
  const btn = (delta: number, txt: string) => (
    <DialogButton
      disabled={disabled || (delta < 0 ? shown <= min : shown >= max)}
      onClick={() => onChange(clamp(shown + delta))}
      style={{ minWidth: 0, flex: 1, padding: "6px 4px", textAlign: "center" }}
    >
      {txt}
    </DialogButton>
  );
  return (
    <Field label={label} childrenLayout="below" bottomSeparator="none">
      <Focusable flow-children="horizontal" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        {coarse ? btn(-coarse, "«") : null}
        {btn(-step, "−")}
        <div style={{ flex: 1.6, textAlign: "center", fontWeight: 600 }}>
          {shown}
          {unit || ""}
        </div>
        {btn(step, "+")}
        {coarse ? btn(coarse, "»") : null}
      </Focusable>
    </Field>
  );
};