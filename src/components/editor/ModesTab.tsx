import { VFC } from "react";
import { DialogButton, ToggleField } from "decky-frontend-lib";
import { slugify, uniqueId } from "../../util";
import { Card, TextRow } from "../inputs";
import { ListRow } from "./parts";
import { DrillProps } from "./types";

export const ModesTab: VFC<DrillProps> = ({ cfg, mutate, busy, sel, setSel }) => {
  const cfgActions = cfg.actions || {};
  const cfgModes = cfg.modes || {};
  const actionIds = Object.keys(cfgActions);
  const modeIds = Object.keys(cfgModes);

  function newMode() {
    mutate((n) => {
      const id = uniqueId(slugify("New mode"), n.modes);
      n.modes[id] = { name: "New mode", actions: [] };
      setSel(id);
    });
  }

  if (sel && cfgModes[sel]) {
    const mid = sel;
    const mode = cfgModes[mid];
    const inMode = mode.actions || [];
    return (
      <div>
        <DialogButton onClick={() => setSel(null)} style={{ marginBottom: "8px" }}>
          ‹ All modes
        </DialogButton>
        <Card title={mode.name || mid}>
          <TextRow
            label="Name"
            value={mode.name}
            onChange={(val) => mutate((n) => { n.modes[mid].name = val; })}
          />
          <div style={{ fontWeight: 600, margin: "6px 0 2px" }}>Actions run in this mode</div>
          {actionIds.length === 0 ? (
            <div style={{ opacity: 0.6 }}>No actions to assign. Create some in the Actions tab.</div>
          ) : (
            actionIds.map((aid) => (
              <ToggleField
                key={aid}
                label={cfgActions[aid].name || aid}
                checked={inMode.indexOf(aid) !== -1}
                disabled={busy}
                onChange={(on) =>
                  mutate((n) => {
                    const arr = (n.modes[mid].actions = n.modes[mid].actions || []);
                    const idx = arr.indexOf(aid);
                    if (on && idx === -1) arr.push(aid);
                    if (!on && idx !== -1) arr.splice(idx, 1);
                  })
                }
              />
            ))
          )}
          <div style={{ marginTop: "10px" }}>
            <DialogButton
              disabled={busy}
              onClick={() => {
                mutate((n) => {
                  delete n.modes[mid];
                  // Clear every setting that points at this mode, not just the
                  // dock pair: the Triggers tab also maps modes into the AC,
                  // controller, resume, and startup slots, and a dangling id
                  // there renders a blank dropdown and saves a mode that's gone.
                  const modeKeys = [
                    "dockedMode", "undockedMode", "acMode", "noAcMode",
                    "controllerConnectMode", "controllerDisconnectMode",
                    "resumeMode", "startupMode",
                  ] as const;
                  for (const k of modeKeys) {
                    if (n.settings[k] === mid) n.settings[k] = "";
                  }
                });
                setSel(null);
              }}
            >
              Delete mode
            </DialogButton>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <DialogButton onClick={newMode} disabled={busy} style={{ marginBottom: "10px" }}>
        + New mode
      </DialogButton>
      {modeIds.length === 0 ? (
        <div style={{ opacity: 0.6 }}>No modes yet. Use “+ New mode” to create one.</div>
      ) : (
        modeIds.map((mid) => (
          <ListRow key={mid} label={cfgModes[mid].name || mid} onClick={() => setSel(mid)} />
        ))
      )}
    </div>
  );
};
