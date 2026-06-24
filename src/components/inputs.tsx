import { VFC } from "react";
import { Field, TextField } from "decky-frontend-lib";

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

export const TextRow: VFC<{ label: string; value?: string; onChange: (v: string) => void }> = (props) => (
  <Field label={props.label} childrenLayout="below" bottomSeparator="none">
    <TextField value={props.value || ""} onChange={(e) => props.onChange(e.target.value)} />
  </Field>
);
