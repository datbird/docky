import { VFC } from "react";
import { ModalRoot } from "decky-frontend-lib";
import { DockyState } from "../util";

const Row: VFC<{ label: string; value: string }> = ({ label, value }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      gap: "12px",
      padding: "8px 0",
      borderBottom: "1px solid rgba(255,255,255,0.1)",
    }}
  >
    <span style={{ opacity: 0.7 }}>{label}</span>
    <span style={{ fontWeight: 600, textAlign: "right" }}>{value}</span>
  </div>
);

// Read-only popup with the Docky status fields that used to sit in the panel.
export const StatusModal: VFC<{
  closeModal?: () => void;
  state: DockyState;
  activeName: string;
}> = ({ closeModal, state, activeName }) => {
  const sunshine = state.sunshine
    ? state.sunshine.running
      ? "Running"
      : state.sunshine.installed
        ? "Installed"
        : "Not installed"
    : "—";
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <div style={{ fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" }}>
        Docky status
      </div>
      <Row
        label="Environment"
        value={state.docked ? "Docked (external display)" : "Handheld"}
      />
      <Row label="Active mode" value={activeName} />
      <Row label="Sunshine" value={sunshine} />
    </ModalRoot>
  );
};
