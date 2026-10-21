import { VFC, useState } from "react";
import { PanelSection, PanelSectionRow, ButtonItem, DropdownItem, ToggleField } from "decky-frontend-lib";
import { ProfileRef, TdpStatus } from "../../util";
import { Stepper } from "../inputs";
import { SectionHeader, useSectionOpen } from "./SectionHeader";

export const TdpSection: VFC<{
  tdp?: TdpStatus;
  tdpProfiles: ProfileRef[];
  busy: boolean;
  fanTdpCall: (method: string, args: any, label: string) => void;
  openEditor: (tab: string) => void;
}> = ({ tdp, tdpProfiles, busy, fanTdpCall, openEditor }) => {
  const [open, toggle] = useSectionOpen("tdp");
  // Local draft for the TDP manual slider (committed on "Apply").
  const [tdpDraft, setTdpDraft] = useState<number | null>(null);

  // TDP label: a saved profile's name, else "Manual" only when Docky is actually
  // holding a cap: enforcing, or the live cap differs from the stock cap. If
  // neither, TDP is at SteamOS's own value (e.g. after release_control, which
  // clears enforce/profile and resets the cap to the kernel default), so show
  // "SteamOS". Kernels with no default fall back to comparing against the max.
  const tdpStock = typeof tdp?.default === "number" ? tdp.default : tdp?.max;
  const tdpLabel = tdp?.profile
    ? (tdpProfiles.find((p) => p.id === tdp.profile)?.name || tdp.profile)
    : (!!tdp?.enforce ||
        (typeof tdp?.watts === "number" && typeof tdpStock === "number" && tdp.watts !== tdpStock))
      ? "Manual"
      : "SteamOS";

  return (
    <PanelSection>
      <PanelSectionRow>
        <SectionHeader title="TDP" open={open} onToggle={toggle} />
      </PanelSectionRow>
      {!open ? null : tdp?.available === false ? (
        <PanelSectionRow>
          <div style={{ opacity: 0.7, padding: "0 4px" }}>No adjustable TDP on this device.</div>
        </PanelSectionRow>
      ) : (
        <>
          <PanelSectionRow>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "0 4px 4px", fontSize: "0.9em" }}>
              <span style={{ opacity: 0.75 }}>
                {typeof tdp?.watts === "number" ? "Now " + tdp.watts + "W" : "—W"}
              </span>
              <span style={{ fontWeight: 600 }}>{tdpLabel}</span>
            </div>
          </PanelSectionRow>
          {tdpProfiles.length ? (
            <PanelSectionRow>
              <DropdownItem
                label="Apply profile"
                rgOptions={tdpProfiles.map((p) => ({ data: p.id, label: p.name + (p.watts ? " (" + p.watts + "W)" : "") }))}
                selectedOption={tdp?.profile || ""}
                onChange={(o) => { setTdpDraft(null); fanTdpCall("apply_tdp_profile", { profile_id: o.data }, "TDP profile"); }}
              />
            </PanelSectionRow>
          ) : null}
          <PanelSectionRow>
            <Stepper
              label="Manual TDP (W)"
              value={tdpDraft ?? tdp?.setWatts ?? 15}
              min={3}
              max={tdp?.max || 15}
              step={1}
              unit="W"
              disabled={busy}
              onChange={(v) => setTdpDraft(v)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={busy}
              onClick={() => {
                const w = tdpDraft ?? tdp?.setWatts ?? 15;
                setTdpDraft(null); // let the polled hardware value drive the display again
                fanTdpCall("set_tdp_watts", { watts: w }, "Set TDP");
              }}
            >
              Apply {tdpDraft ?? tdp?.setWatts ?? 15}W
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Keep enforced"
              description="Re-apply continuously so Steam's TDP slider can't override it"
              checked={!!tdp?.enforce}
              disabled={busy}
              onChange={(v) => fanTdpCall("set_tdp_enforce", { on: v }, "TDP enforce " + (v ? "on" : "off"))}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => openEditor("tdp")}>
              Manage TDP profiles…
            </ButtonItem>
          </PanelSectionRow>
        </>
      )}
    </PanelSection>
  );
};
