import { VFC } from "react";
import { DialogButton, DropdownItem } from "decky-frontend-lib";
import { CurvePoint, slugify, uniqueId } from "../../util";
import { Card, TextRow, Stepper } from "../inputs";
import { CurveEditor, sortPoints } from "../CurveEditor";
import { ListRow } from "./parts";
import { DrillProps } from "./types";

const fanMax = 8000;

export const FanTab: VFC<DrillProps> = ({ cfg, mutate, busy, sel, setSel }) => {
  const cfgFanProfiles = cfg.fanProfiles || {};

  function newFanProfile() {
    mutate((n) => {
      n.fanProfiles = n.fanProfiles || {};
      const id = uniqueId(slugify("New fan profile"), n.fanProfiles);
      n.fanProfiles[id] = {
        name: "New fan profile",
        mode: "curve",
        manualRpm: 3000,
        // Mirrors deckops.DEFAULT_FAN_CURVE / docky.py default_config(). The
        // frontend has no import path to the Python constant, so if you retune
        // the starter curve, retune it in all three places -- they WILL drift
        // otherwise.
        curve: {
          interpolate: true,
          points: [
            { temp: 45, rpm: 0 },
            { temp: 55, rpm: 1800 },
            { temp: 65, rpm: 3200 },
            { temp: 75, rpm: 4800 },
            { temp: 85, rpm: 6500 },
          ],
        },
      };
      setSel(id);
    });
  }

  if (sel && cfgFanProfiles[sel]) {
    const id = sel;
    const prof = cfgFanProfiles[id];
    const mode = prof.mode || "curve";
    const curve = prof.curve || { interpolate: true, points: [] };
    return (
      <div>
        <DialogButton onClick={() => setSel(null)} style={{ marginBottom: "8px" }}>
          ‹ All fan profiles
        </DialogButton>
        <Card title={prof.name || id}>
          <TextRow label="Name" value={prof.name} onChange={(v) => mutate((n) => { n.fanProfiles![id].name = v; })} />
          <DropdownItem
            label="Mode"
            rgOptions={[
              { data: "curve", label: "Curve (temperature → RPM)" },
              { data: "manual", label: "Manual (fixed RPM)" },
              { data: "auto", label: "Auto (SteamOS)" },
            ]}
            selectedOption={mode}
            onChange={(o) => mutate((n) => { n.fanProfiles![id].mode = o.data as any; })}
          />
          {mode === "manual" ? (
            <Stepper
              label="Fan RPM"
              value={prof.manualRpm ?? 3000}
              min={0}
              max={fanMax}
              step={100}
              coarse={1000}
              disabled={busy}
              onChange={(v) => mutate((n) => { n.fanProfiles![id].manualRpm = v; })}
            />
          ) : null}
          {mode === "curve" ? (
            <CurveEditor
              points={(curve.points || []).map((p) => ({ temp: p.temp, rpm: p.rpm }))}
              interpolate={curve.interpolate !== false}
              maxRpm={fanMax}
              busy={busy}
              onPoints={(p: CurvePoint[]) => mutate((n) => { const c = n.fanProfiles![id].curve || {}; n.fanProfiles![id].curve = { interpolate: c.interpolate !== false, points: sortPoints(p) }; })}
              onInterpolate={(b) => mutate((n) => { const c = n.fanProfiles![id].curve || { points: [] }; n.fanProfiles![id].curve = { interpolate: b, points: c.points || [] }; })}
            />
          ) : null}
          {mode === "auto" ? (
            <div style={{ opacity: 0.7, fontSize: "0.85em", margin: "4px 0" }}>
              Applying this profile hands the fan back to SteamOS.
            </div>
          ) : null}
          {/* No per-tab Save: edits go into the draft via mutate() and persist
              through the top-bar Save, same as every other tab. (The old
              "Save profile" button here called saveCfg, which writes the WHOLE
              config -- so it would also commit pending edits from other tabs
              under a profile-scoped label.) */}
          <div style={{ marginTop: "10px" }}>
            <DialogButton
              disabled={busy}
              onClick={() => { mutate((n) => { delete n.fanProfiles![id]; }); setSel(null); }}
            >
              Delete profile
            </DialogButton>
          </div>
        </Card>
      </div>
    );
  }

  const ids = Object.keys(cfgFanProfiles);
  return (
    <div>
      <DialogButton onClick={newFanProfile} disabled={busy} style={{ marginBottom: "10px" }}>
        + New fan profile
      </DialogButton>
      {ids.length === 0 ? (
        <div style={{ opacity: 0.6 }}>
          No fan profiles yet. Create curves/manual presets here, then apply them from the panel,
          a task, or a mode.
        </div>
      ) : (
        ids.map((id) => (
          <ListRow key={id} label={cfgFanProfiles[id].name || id} sub={cfgFanProfiles[id].mode || "curve"} onClick={() => setSel(id)} />
        ))
      )}
    </div>
  );
};
