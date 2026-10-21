import { VFC } from "react";
import { DialogButton } from "decky-frontend-lib";

// One tab button in the top tab bar.
export const TabButton: VFC<{ active: boolean; label: string; onClick: () => void }> = ({
  active,
  label,
  onClick,
}) => (
  <DialogButton
    onClick={onClick}
    style={{
      flex: 1,
      minWidth: 0,
      padding: "6px 4px",
      fontWeight: active ? 700 : 400,
      background: active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.04)",
      borderBottom: active ? "2px solid #1a9fff" : "2px solid transparent",
      borderRadius: "4px 4px 0 0",
    }}
  >
    {label}
  </DialogButton>
);

// A full-width row that drills into an item's detail when clicked.
export const ListRow: VFC<{ label: string; sub?: string; onClick: () => void }> = ({ label, sub, onClick }) => (
  <DialogButton
    onClick={onClick}
    style={{
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "6px",
      textAlign: "left",
    }}
  >
    <span style={{ fontWeight: 600 }}>{label}</span>
    <span style={{ opacity: 0.6, fontSize: "0.85em" }}>{sub ? sub + " ›" : "›"}</span>
  </DialogButton>
);
