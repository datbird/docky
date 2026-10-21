import { VFC } from "react";
import { PanelSection, PanelSectionRow, ButtonItem, DialogButton, DropdownItem, Focusable } from "decky-frontend-lib";
import { DockyState, FanStatus, ProfileRef } from "../../util";
import { FanModal } from "../FanModal";
import { SectionHeader, useSectionOpen } from "./SectionHeader";

export const FanSection: VFC<{
  fan?: FanStatus;
  fanProfiles: ProfileRef[];
  busy: boolean;
  fanTdpCall: (method: string, args: any, label: string) => void;
  openModal: (node: any) => void;
  openEditor: (tab: string) => void;
  onSaved: (st: DockyState) => void;
}> = ({ fan, fanProfiles, busy, fanTdpCall, openModal, openEditor, onSaved }) => {
  const [open, toggle] = useSectionOpen("fan");
  return (
    <PanelSection>
      <PanelSectionRow>
        <SectionHeader title="Fan" open={open} onToggle={toggle} />
      </PanelSectionRow>
      {!open ? null : (
        <>
          <PanelSectionRow>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "0 4px 4px", fontSize: "0.9em" }}>
              <span style={{ opacity: 0.75 }}>
                {typeof fan?.tempC === "number" ? fan.tempC + "°C" : "—°C"} ·{" "}
                {typeof fan?.rpm === "number" ? fan.rpm + " RPM" : "— RPM"}
              </span>
              <span style={{ fontWeight: 600 }}>
                {fan?.profile
                  ? (fanProfiles.find((p) => p.id === fan.profile)?.name || fan.profile)
                  : fan?.mode === "manual"
                    ? "Manual"
                    : fan?.mode === "curve"
                      ? "Custom curve"
                      : "SteamOS"}
              </span>
            </div>
          </PanelSectionRow>
          {fanProfiles.length ? (
            <PanelSectionRow>
              <DropdownItem
                label="Apply profile"
                rgOptions={[{ data: "auto", label: "Auto (SteamOS)" }].concat(
                  fanProfiles.map((p) => ({ data: p.id, label: p.name }))
                )}
                selectedOption={fan?.profile || "auto"}
                onChange={(o) => fanTdpCall("apply_fan_profile", { profile_id: o.data }, "Fan profile")}
              />
            </PanelSectionRow>
          ) : null}
          <PanelSectionRow>
            <Focusable flow-children="horizontal" style={{ display: "flex", gap: "6px" }}>
              {(["auto", "curve", "manual"] as const).map((m) => (
                <DialogButton
                  key={m}
                  disabled={busy || fan?.available === false}
                  onClick={() => fanTdpCall("set_fan_mode", { mode: m }, "Fan: " + m)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "6px 4px",
                    // Border + weight only; an inline background hides Steam's
                    // focus background and leaves its dark focus text unreadable.
                    fontWeight: (fan?.mode || "auto") === m ? 700 : 400,
                    border: (fan?.mode || "auto") === m ? "2px solid #5b7cf0" : "2px solid transparent",
                  }}
                >
                  {m === "auto" ? "Auto" : m === "curve" ? "Curve" : "Manual"}
                </DialogButton>
              ))}
            </Focusable>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy}
              onClick={() => openModal(<FanModal onSaved={onSaved} />)}
            >
              Edit fan curve…
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => openEditor("fan")}>
              Manage fan profiles…
            </ButtonItem>
          </PanelSectionRow>
        </>
      )}
    </PanelSection>
  );
};
