import { VFC } from "react";
import { PanelSection, PanelSectionRow, Focusable, ToggleField, showModal, ConfirmModal } from "decky-frontend-lib";
import { DockyState } from "../../util";
import { PairModal } from "../PairModal";
import { DockIcon, IconButton, PlayIcon, RestartIcon, StopIcon } from "./icons";
import { SectionHeader, useSectionOpen } from "./SectionHeader";

export const SunshineSection: VFC<{
  sun: DockyState["sunshine"];
  busy: boolean;
  openModal: (node: any) => void;
  setState: (st: DockyState) => void;
  sunshineControl: (method: "sunshine_start" | "sunshine_stop" | "sunshine_restart", verb: string) => void;
  sunshineToggle: (method: string, key: string, v: boolean, label: string) => void;
}> = ({ sun, busy, openModal, setState, sunshineControl, sunshineToggle }) => {
  const [open, toggle] = useSectionOpen("sunshine");

  // HEVC is the only codec that can carry HDR, but on this hardware it is also
  // the one that misbehaves — so enabling it is a deliberate trade, not a
  // preference. Turning it ON asks first; turning it OFF is immediate, because
  // returning to the working configuration should never need permission.
  function toggleHevc(v: boolean) {
    if (!v) {
      sunshineToggle("set_sunshine_hevc", "hevc", false, "Disabling HEVC");
      return;
    }
    showModal(
      <ConfirmModal
        strTitle="Enable HEVC / HDR?"
        strDescription={
          "HEVC is required for HDR streaming, but on the Steam Deck it is known to " +
          "stutter, run slower than H.264, and on some hosts produce a black screen " +
          "with working audio and input.\n\n" +
          "Clients set to 'Automatic' will prefer HEVC once it's offered, so this " +
          "affects every device — not just the one you're testing.\n\n" +
          "Sunshine restarts to apply (a live stream is left alone; it applies afterwards)."
        }
        strOKButtonText="Enable anyway"
        strCancelButtonText="Cancel"
        onOK={() => sunshineToggle("set_sunshine_hevc", "hevc", true, "Enabling HEVC")}
      />,
    );
  }

  return (
    <PanelSection>
      <PanelSectionRow>
        <SectionHeader title="Sunshine" open={open} onToggle={toggle} />
      </PanelSectionRow>
      {!open ? null : (
        <>
          <PanelSectionRow>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "0 4px 4px", fontSize: "0.9em" }}>
              <span style={{ opacity: 0.75 }}>
                {!sun ? "—" : !sun.installed ? "Not installed" : sun.running ? "Running" : "Stopped"}
              </span>
              <span style={{ fontWeight: 600 }}>
                {sun?.resolvedEngine === "decky-sunshine" ? "decky-sunshine" : sun?.resolvedEngine === "off" ? "Off" : "Docky"}
              </span>
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <Focusable
              flow-children="horizontal"
              style={{ display: "flex", gap: "8px" }}
            >
              <IconButton
                label="Pair"
                flex={2}
                disabled={busy || !(sun && sun.running)}
                onClick={() =>
                  openModal(
                    <PairModal
                      credsStored={!!(sun && sun.credsStored)}
                      onState={(st) => st && setState(st)}
                    />
                  )
                }
              >
                <DockIcon />
              </IconButton>
              <IconButton
                disabled={busy || !(sun && sun.running)}
                onClick={() => sunshineControl("sunshine_restart", "Restarting")}
              >
                <RestartIcon />
              </IconButton>
              <IconButton
                disabled={busy || !(sun && sun.installed)}
                onClick={() =>
                  sun && sun.running
                    ? sunshineControl("sunshine_stop", "Stopping")
                    : sunshineControl("sunshine_start", "Starting")
                }
              >
                {sun && sun.running ? <StopIcon /> : <PlayIcon />}
              </IconButton>
            </Focusable>
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Fix stretched image when docked"
              description="Forces gamescope composition; re-applied automatically after reboots."
              checked={!!(sun && sun.forceComposition)}
              disabled={busy}
              onChange={(v: boolean) =>
                sunshineToggle("set_force_composition", "forceComposition", v, "Updating composition")
              }
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="HEVC / HDR support"
              // Defaults ON in Sunshine (hevc_mode 0 advertises HEVC when the
              // encoder supports it), so this reads `!== false` rather than the
              // `!!` the other toggles use — an absent value means "advertised".
              description="Required for HDR. Expect stutter, lower performance, and possible black screens — leave off unless you specifically want HDR."
              checked={!(sun && sun.hevc === false)}
              disabled={busy}
              onChange={toggleHevc}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Keep Sunshine running"
              // Defaults ON: watchdog is enabled unless the backend explicitly
              // sends watchdog:false. This is the one toggle that inverts (the
              // others default off via !!), because a missing value here should
              // read as "the safety net is on", not "off".
              description="Relaunch Sunshine automatically if it crashes."
              checked={!(sun && sun.watchdog === false)}
              disabled={busy}
              onChange={(v: boolean) =>
                sunshineToggle("set_sunshine_watchdog", "watchdog", v, "Updating watchdog")
              }
            />
          </PanelSectionRow>
        </>
      )}
    </PanelSection>
  );
};
