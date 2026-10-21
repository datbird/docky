import { VFC, useState, useEffect } from "react";
import { DialogButton, ToggleField, DropdownItem, Focusable } from "decky-frontend-lib";
import { call, errText } from "../../util";
import { TabId, TabProps } from "./types";

interface SunshineInfo {
  installed: boolean;
  installedVersion: string;
  latestVersion: string;
  installedDate?: string;
  latestDate?: string;
  updateAvailable: boolean;
  engine?: string;
  resolvedEngine?: string;
  deckySunshineInstalled?: boolean;
}

export interface SunshineLive {
  info: SunshineInfo | null;
  busy: boolean;
  msg: string;
  refresh: () => void;
  run: (method: string, verb: string) => void;
}

// Sunshine tab state (live actions, not part of the config draft). Called from
// the editor so the info survives switching tabs.
export function useSunshineLive(tab: TabId, onSaved: (state: any) => void): SunshineLive {
  const [info, setInfo] = useState<SunshineInfo | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");

  function refresh() {
    setBusy(true);
    setMsg("Checking flathub…");
    call<SunshineInfo>("sunshine_version_info")
      .then((r) => {
        setBusy(false);
        setInfo(r);
        setMsg("");
      })
      .catch((err) => {
        setBusy(false);
        setMsg("Error: " + errText(err));
      });
  }

  function run(method: string, verb: string) {
    setBusy(true);
    setMsg(verb + " Sunshine… (this can take a minute)");
    call<any>(method)
      .then((r) => {
        setBusy(false);
        if (r && r.info) setInfo(r.info);
        if (r && r.state) onSaved(r.state);
        setMsg(r && r.message ? r.message : verb + " done");
      })
      .catch((err) => {
        setBusy(false);
        setMsg("Error: " + errText(err));
      });
  }

  // Check versions the first time the Sunshine tab is opened.
  useEffect(() => {
    if (tab === "sunshine" && !info && !busy) refresh();
  }, [tab]);

  return { info, busy, msg, refresh, run };
}

// "2026.516.143833 (2026-09-15)". The build date matters when Flathub ships a
// new commit under an unchanged version string.
function withDate(version: string, date?: string): string {
  return date ? `${version || "—"} (${date})` : version;
}

// A label/value row in the Sunshine tab (module-scope so it isn't remounted on
// every render of the editor).
const InfoRow: VFC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
    <span style={{ opacity: 0.7 }}>{label}</span>
    <span style={{ fontWeight: 600 }}>{value || "—"}</span>
  </div>
);

export const SunshineTab: VFC<TabProps & { installedPlugins: string[]; live: SunshineLive }> = ({
  cfg,
  mutate,
  busy,
  installedPlugins,
  live,
}) => {
  const info = live.info;
  const sunBusy = live.busy;
  const engine = cfg.settings.sunshineEngine || "auto";
  const deckyInstalled =
    (info && info.deckySunshineInstalled) ||
    installedPlugins.indexOf("decky-sunshine") !== -1;
  // What's actually in effect (server-resolved when on auto).
  const resolved = info && info.resolvedEngine
    ? info.resolvedEngine
    : engine !== "auto"
      ? engine
      : deckyInstalled ? "decky-sunshine" : info && info.installed ? "integrated" : "off";
  // Until sunshine_info answers, `resolved` on Auto is only a guess, and the
  // guess is "off". Say "checking" instead of telling the user Sunshine isn't
  // set up for the few seconds the flatpak probe takes.
  const loading = !info && engine === "auto";
  const integrated = resolved === "integrated";
  const isDecky = resolved === "decky-sunshine";
  const isOff = resolved === "off";
  const blurb = loading
    ? "Checking Sunshine…"
    : isDecky
      ? "Using the decky-sunshine plugin for install/launch/update. Docky's other Sunshine tasks (stop, encoder, composition, pairing) still work on the shared Sunshine."
      : isOff
        ? "Sunshine isn't set up yet. Install & enable it below to let Docky manage it, or install the decky-sunshine plugin and Docky will use that automatically."
        : "Docky owns Sunshine: installs it from Flathub, launches it, and keeps it updated.";
  return (
    <div>
      <div style={{ fontWeight: 700, margin: "2px 0 6px" }}>Sunshine</div>
      <div style={{ fontSize: "0.8em", opacity: 0.6, marginBottom: "10px" }}>{blurb}</div>

      <DropdownItem
        label="Sunshine engine"
        rgOptions={[
          { data: "auto", label: "Auto" + (engine === "auto" && !loading ? " → " + resolved : "") },
          { data: "integrated", label: "Integrated (Docky)" },
          {
            data: "decky-sunshine",
            label: "decky-sunshine" + (deckyInstalled ? "" : " (not installed)"),
          },
          { data: "off", label: "Off" },
        ]}
        selectedOption={engine}
        onChange={(o) => mutate((n) => { n.settings.sunshineEngine = o.data; })}
      />
      {engine === "decky-sunshine" && !deckyInstalled ? (
        <div style={{ color: "#e8a33d", fontSize: "0.8em", margin: "4px 0" }}>
          decky-sunshine isn’t installed — install it from the Decky store, or
          use Auto / Integrated.
        </div>
      ) : null}
      {engine === "integrated" && deckyInstalled ? (
        <div style={{ color: "#e8a33d", fontSize: "0.8em", margin: "4px 0" }}>
          decky-sunshine is also installed. With Integrated, both may try to
          launch Sunshine and fight over the streaming port. Use Auto
          (recommended), or disable decky-sunshine’s autostart.
        </div>
      ) : null}

      {!info ? (
        <div style={{ opacity: 0.6 }}>{sunBusy ? "Checking…" : "—"}</div>
      ) : (
        <>
          <InfoRow label="Status" value={info.installed ? "Installed" : "Not installed"} />
          <InfoRow label="Current version" value={withDate(info.installedVersion, info.installedDate)} />
          <InfoRow label="Latest version" value={withDate(info.latestVersion, info.latestDate)} />
          {info.installed ? (
            <div
              style={{
                fontSize: "0.85em",
                margin: "4px 0",
                color: info.updateAvailable ? "#e8a33d" : undefined,
                opacity: info.updateAvailable ? 1 : 0.6,
              }}
            >
              {info.updateAvailable ? "Update available" : "Up to date"}
            </div>
          ) : null}
        </>
      )}

      <Focusable
        flow-children="horizontal"
        style={{ display: "flex", gap: "8px", marginTop: "10px" }}
      >
        {isDecky ? null : info && !info.installed ? (
          <DialogButton disabled={sunBusy} onClick={() => live.run("sunshine_install", "Installing")}>
            Install &amp; enable Sunshine
          </DialogButton>
        ) : (
          <DialogButton
            disabled={sunBusy || !(info && info.updateAvailable)}
            onClick={() => live.run("sunshine_update", "Updating")}
          >
            Update Sunshine
          </DialogButton>
        )}
        <DialogButton disabled={sunBusy} onClick={live.refresh}>
          Refresh
        </DialogButton>
      </Focusable>
      {isDecky ? (
        <div style={{ fontSize: "0.8em", opacity: 0.6, marginTop: "6px" }}>
          Install &amp; updates are managed in decky-sunshine.
        </div>
      ) : null}
      {live.msg ? (
        <div style={{ fontSize: "0.8em", opacity: 0.8, marginTop: "10px" }}>{live.msg}</div>
      ) : null}

      <div style={{ fontWeight: 700, margin: "14px 0 2px" }}>Behavior</div>
      <ToggleField
        label="Start Sunshine at boot"
        description={
          loading
            ? "Checking Sunshine…"
            : integrated
            ? "Launch Sunshine when Docky loads after a reboot"
            : isOff
            ? "Sunshine is off in this mode"
            : "Managed by decky-sunshine in this mode"
        }
        checked={integrated && cfg.settings.autostartSunshine !== false}
        disabled={busy || !integrated}
        onChange={(on) => mutate((n) => { n.settings.autostartSunshine = on; })}
      />
    </div>
  );
};
