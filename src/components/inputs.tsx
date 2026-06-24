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
  const Btn: VFC<{ delta: number; txt: string }> = ({ delta, txt }) => (
    <DialogButton
      disabled={disabled || (delta < 0 ? value <= min : value >= max)}
      onClick={() => onChange(clamp(value + delta))}
      style={{ minWidth: 0, flex: 1, padding: "6px 4px", textAlign: "center" }}
    >
      {txt}
    </DialogButton>
  );
  return (
    <Field label={label} childrenLayout="below" bottomSeparator="none">
      <Focusable flow-children="horizontal" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        {coarse ? <Btn delta={-coarse} txt="«" /> : null}
        <Btn delta={-step} txt="−" />
        <div style={{ flex: 1.6, textAlign: "center", fontWeight: 600 }}>
          {value}
          {unit || ""}
        </div>
        <Btn delta={step} txt="+" />
        {coarse ? <Btn delta={coarse} txt="»" /> : null}
      </Focusable>
    </Field>
  );
};
