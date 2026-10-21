import { VFC, useState } from "react";
import { DialogButton } from "decky-frontend-lib";

// Clickable section header that expands/collapses the rows below it. Styled to
// read like a PanelSection title but works with the gamepad (it's a button).
export const SectionHeader: VFC<{ title: string; open: boolean; onToggle: () => void }> = ({
  title,
  open,
  onToggle,
}) => (
  <DialogButton
    onClick={onToggle}
    style={{
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "4px 8px",
      minHeight: 0,
    }}
  >
    <span style={{ fontWeight: 700, fontSize: "0.85em", letterSpacing: "0.05em", textTransform: "uppercase", opacity: 0.85 }}>
      {title}
    </span>
    <span style={{ opacity: 0.7 }}>{open ? "▾" : "▸"}</span>
  </DialogButton>
);

// Which panel sections are expanded. Kept at module level, not in component
// state, because opening any modal closes the Quick Access menu and unmounts
// Content: component state reset every section to collapsed after each modal.
// This lives as long as the plugin is loaded, which is the lifetime wanted.
const sectionOpen: Record<string, boolean> = {};

export function useSectionOpen(key: string): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(!!sectionOpen[key]);
  return [open, () => { sectionOpen[key] = !open; setOpen(!open); }];
}
