import { VFC } from "react";
import { DialogButton } from "decky-frontend-lib";
import { slugify, uniqueId } from "../../util";
import { Card, TextRow, Stepper } from "../inputs";
import { ListRow } from "./parts";
import { DrillProps } from "./types";

const tdpMax = 30;

export const TdpTab: VFC<DrillProps> = ({ cfg, mutate, busy, sel, setSel }) => {
  const cfgTdpProfiles = cfg.tdpProfiles || {};

  function newTdpProfile() {
    mutate((n) => {
      n.tdpProfiles = n.tdpProfiles || {};
      const id = uniqueId(slugify("New TDP profile"), n.tdpProfiles);
      n.tdpProfiles[id] = { name: "New TDP profile", watts: 15 };
      setSel(id);
    });
  }

  if (sel && cfgTdpProfiles[sel]) {
    const id = sel;
    const prof = cfgTdpProfiles[id];
    return (
      <div>
        <DialogButton onClick={() => setSel(null)} style={{ marginBottom: "8px" }}>
          ‹ All TDP profiles
        </DialogButton>
        <Card title={prof.name || id}>
          <TextRow label="Name" value={prof.name} onChange={(v) => mutate((n) => { n.tdpProfiles![id].name = v; })} />
          <Stepper
            label="TDP (watts)"
            value={prof.watts ?? 15}
            min={3}
            max={tdpMax}
            step={1}
            unit="W"
            disabled={busy}
            onChange={(v) => mutate((n) => { n.tdpProfiles![id].watts = v; })}
          />
          <div style={{ fontSize: "0.7em", opacity: 0.6, margin: "2px 0 8px" }}>
            The slider goes to {tdpMax}W; an unlocked BIOS is required to exceed the stock 15W cap.
          </div>
          <DialogButton
            disabled={busy}
            onClick={() => { mutate((n) => { delete n.tdpProfiles![id]; }); setSel(null); }}
          >
            Delete profile
          </DialogButton>
        </Card>
      </div>
    );
  }

  const ids = Object.keys(cfgTdpProfiles);
  return (
    <div>
      <DialogButton onClick={newTdpProfile} disabled={busy} style={{ marginBottom: "10px" }}>
        + New TDP profile
      </DialogButton>
      {ids.length === 0 ? (
        <div style={{ opacity: 0.6 }}>
          No TDP profiles yet. Create wattage presets here, then apply them from the panel, a task,
          or a mode.
        </div>
      ) : (
        ids.map((id) => (
          <ListRow key={id} label={cfgTdpProfiles[id].name || id} sub={(cfgTdpProfiles[id].watts ?? "?") + "W"} onClick={() => setSel(id)} />
        ))
      )}
    </div>
  );
};
