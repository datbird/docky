import { VFC } from "react";
import { ToggleField, DropdownItem } from "decky-frontend-lib";
import { TextRow } from "../inputs";
import { TabProps } from "./types";

// Mode mappings for dock / AC / controller / resume / startup.
export const TriggersTab: VFC<TabProps> = ({ cfg, mutate }) => {
  const cfgModes = cfg.modes || {};
  const modeOpts = [{ data: "", label: "(none)" }].concat(
    Object.keys(cfgModes).map((mid) => ({ data: mid, label: cfgModes[mid].name || mid }))
  );
  const strict = cfg.settings.requireExternalDisplay !== false; // default true
  return (
    <div>
      <div style={{ fontWeight: 700, margin: "2px 0 2px" }}>Dock</div>
      <div style={{ fontSize: "0.8em", opacity: 0.6, marginBottom: "6px" }}>
        How a dock is detected, and which mode to switch to on dock / undock.
      </div>
      <ToggleField
        label="Require an external display"
        description="Docked only when a monitor is actually connected. Uncheck to detect a dock that has no display attached."
        checked={strict}
        onChange={(on) => mutate((n) => { n.settings.requireExternalDisplay = on; })}
      />
      <ToggleField
        label="Require AC power"
        description="Count external power as docked. Note: a plain wall charger counts too."
        checked={!!cfg.settings.requireAcPower}
        disabled={strict}
        onChange={(on) => mutate((n) => { n.settings.requireAcPower = on; })}
      />
      <ToggleField
        label="Require a USB hub (dock)"
        description="Count an attached USB hub / dock as docked. Enable both to mean a real dock (AC + hub)."
        checked={!!cfg.settings.requireUsbHub}
        disabled={strict}
        onChange={(on) => mutate((n) => { n.settings.requireUsbHub = on; })}
      />
      <DropdownItem
        label="When docked → mode"
        rgOptions={modeOpts}
        selectedOption={cfg.settings.dockedMode || ""}
        onChange={(o) => mutate((n) => { n.settings.dockedMode = o.data; })}
      />
      <DropdownItem
        label="When undocked → mode"
        rgOptions={modeOpts}
        selectedOption={cfg.settings.undockedMode || ""}
        onChange={(o) => mutate((n) => { n.settings.undockedMode = o.data; })}
      />

      <div style={{ fontWeight: 700, margin: "14px 0 2px" }}>AC power</div>
      <DropdownItem
        label="When AC connects → mode"
        rgOptions={modeOpts}
        selectedOption={cfg.settings.acMode || ""}
        onChange={(o) => mutate((n) => { n.settings.acMode = o.data; })}
      />
      <DropdownItem
        label="When on battery → mode"
        rgOptions={modeOpts}
        selectedOption={cfg.settings.noAcMode || ""}
        onChange={(o) => mutate((n) => { n.settings.noAcMode = o.data; })}
      />

      <div style={{ fontWeight: 700, margin: "14px 0 2px" }}>External controller</div>
      <DropdownItem
        label="When a controller connects → mode"
        rgOptions={modeOpts}
        selectedOption={cfg.settings.controllerConnectMode || ""}
        onChange={(o) => mutate((n) => { n.settings.controllerConnectMode = o.data; })}
      />
      <DropdownItem
        label="When it disconnects → mode"
        rgOptions={modeOpts}
        selectedOption={cfg.settings.controllerDisconnectMode || ""}
        onChange={(o) => mutate((n) => { n.settings.controllerDisconnectMode = o.data; })}
      />

      <div style={{ fontWeight: 700, margin: "14px 0 2px" }}>Resume &amp; startup</div>
      <DropdownItem
        label="On wake from sleep → mode"
        rgOptions={modeOpts}
        selectedOption={cfg.settings.resumeMode || ""}
        onChange={(o) => mutate((n) => { n.settings.resumeMode = o.data; })}
      />
      <DropdownItem
        label="On startup (boot) → mode"
        rgOptions={modeOpts}
        selectedOption={cfg.settings.startupMode || ""}
        onChange={(o) => mutate((n) => { n.settings.startupMode = o.data; })}
      />

      <TextRow
        label="Poll interval (seconds)"
        value={String(cfg.settings.pollSeconds || 3)}
        onChange={(val) =>
          mutate((n) => {
            const num = parseInt(val, 10);
            // Clamp to the backend's own [1, 3600] range so the UI never
            // shows a value the backend will silently rewrite on read.
            n.settings.pollSeconds = isNaN(num) ? 3 : Math.max(1, Math.min(3600, num));
          })
        }
      />
      <div style={{ fontSize: "0.7em", opacity: 0.6, marginTop: "6px" }}>
        Enable each trigger from the panel's Triggers section; map it to a mode here.
      </div>
    </div>
  );
};
