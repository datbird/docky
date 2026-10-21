import { VFC } from "react";
import { PanelSection, PanelSectionRow, ToggleField } from "decky-frontend-lib";
import { Settings } from "../../util";
import { SectionHeader, useSectionOpen } from "./SectionHeader";

const TRIGGERS = [
  { key: "autoDockDetection", label: "Dock / undock", desc: "Switch modes when you dock or undock" },
  { key: "autoAcDetection", label: "AC power", desc: "Switch modes when AC power connects/disconnects" },
  { key: "autoControllerDetection", label: "External controller", desc: "Switch modes when a controller connects/disconnects" },
  { key: "autoResume", label: "Resume from sleep", desc: "Re-apply a mode when the Deck wakes" },
  { key: "autoStartup", label: "Startup", desc: "Apply a mode when Docky loads at boot" },
];

export const TriggersSection: VFC<{
  settings: Settings;
  busy: boolean;
  toggleTrigger: (key: string, label: string, v: boolean) => void;
}> = ({ settings, busy, toggleTrigger }) => {
  const [open, toggle] = useSectionOpen("triggers");
  return (
    <PanelSection>
      <PanelSectionRow>
        <SectionHeader title="Triggers" open={open} onToggle={toggle} />
      </PanelSectionRow>
      {!open
        ? null
        : TRIGGERS.map((t) => (
            <PanelSectionRow key={t.key}>
              <ToggleField
                label={t.label}
                description={t.desc}
                checked={!!(settings as any)[t.key]}
                disabled={busy}
                onChange={(v) => toggleTrigger(t.key, t.label, v)}
              />
            </PanelSectionRow>
          ))}
      {open ? (
        <PanelSectionRow>
          <div style={{ fontSize: "0.7em", opacity: 0.6, padding: "0 4px" }}>
            Map each trigger to a mode in Settings (gear) → Triggers.
          </div>
        </PanelSectionRow>
      ) : null}
    </PanelSection>
  );
};
