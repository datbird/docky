import { VFC } from "react";
import { PanelSection, PanelSectionRow, ButtonItem } from "decky-frontend-lib";
import { StateFavorite } from "../../util";
import { StatusDot } from "./icons";
import { SectionHeader, useSectionOpen } from "./SectionHeader";

export const FavoritesSection: VFC<{
  favorites: StateFavorite[];
  activeMode?: string;
  busy: boolean;
  doCall: (method: string, args: any, label: string) => void;
}> = ({ favorites, activeMode, busy, doCall }) => {
  const [open, toggle] = useSectionOpen("favorites");
  return (
    <PanelSection>
      <PanelSectionRow>
        <SectionHeader title="Favorites" open={open} onToggle={toggle} />
      </PanelSectionRow>
      {!open ? null : favorites.length ? (
        favorites.map((f) => {
          const isActive = f.kind === "mode" && f.id === activeMode;
          const hasStatus = typeof f.status === "boolean";
          return (
            <PanelSectionRow key={"f_" + f.kind + "_" + f.id}>
              <ButtonItem
                layout="below"
                disabled={busy || f.missing}
                description={
                  hasStatus
                    ? "Action · " + (f.status ? "on" : "off")
                    : f.kind === "mode"
                      ? isActive ? "Mode · active" : "Mode"
                      : "Action"
                }
                onClick={() =>
                  f.kind === "mode"
                    ? doCall("activate_mode", { mode_id: f.id }, "Switching to " + f.name)
                    : doCall("run_action", { action_id: f.id }, "Running " + f.name)
                }
              >
                <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  {hasStatus ? <StatusDot on={!!f.status} /> : null}
                  <span>
                    {(hasStatus ? "" : isActive ? "✓ " : "★ ") +
                      (f.kind === "mode" ? "" : (f.verb ? f.verb : "Run") + ": ") +
                      f.name +
                      (f.missing ? " (missing)" : "")}
                  </span>
                </span>
              </ButtonItem>
            </PanelSectionRow>
          );
        })
      ) : (
        <PanelSectionRow>
          <div style={{ opacity: 0.7, padding: "0 4px" }}>
            No favorites yet. Open Settings (gear) → Favorites to pin actions
            and modes here.
          </div>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
};
