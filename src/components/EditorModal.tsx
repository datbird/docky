import { VFC, useState, useEffect, useRef } from "react";
import { ModalRoot, DialogButton, Focusable } from "decky-frontend-lib";
import { Config, call, clone, errText, stripTaskKeys, toast, withTaskKeys } from "../util";
import { TabId } from "./editor/types";
import { TabButton } from "./editor/parts";
import { ActionsTab } from "./editor/ActionsTab";
import { ModesTab } from "./editor/ModesTab";
import { FavoritesTab } from "./editor/FavoritesTab";
import { FanTab } from "./editor/FanTab";
import { TdpTab } from "./editor/TdpTab";
import { SunshineTab, useSunshineLive } from "./editor/SunshineTab";
import { TriggersTab } from "./editor/TriggersTab";

export const EditorModal: VFC<{
  closeModal?: () => void;
  initialConfig: Config;
  initialTab?: TabId;
  profiles: string[];
  installedPlugins: string[];
  onSaved: (state: any) => void;
}> = ({ closeModal, initialConfig, initialTab, profiles, installedPlugins, onSaved }) => {
  const [cfg, setCfg] = useState<Config>(() => withTaskKeys(clone(initialConfig)));
  const [dirty, setDirty] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [tab, setTab] = useState<TabId>(initialTab || "actions");
  const [selAction, setSelAction] = useState<string | null>(null);
  const [selMode, setSelMode] = useState<string | null>(null);
  const [selFan, setSelFan] = useState<string | null>(null);
  const [selTdp, setSelTdp] = useState<string | null>(null);
  // Two-step guard on discarding unsaved edits: first Cancel arms, second
  // confirms. Cancel sits one stick-nudge from Save, and closing throws away the
  // whole draft (edits only persist on Save), so a bare Cancel is a lot of work
  // to lose to a fat finger.
  const [confirmCancel, setConfirmCancel] = useState<boolean>(false);
  const sunshine = useSunshineLive(tab, onSaved);

  // saveCfg persists from cfgRef.current rather than its closed-over `cfg`, so it
  // always writes the latest committed draft even if the Save handler were ever
  // invoked from an older render's closure. Updated after commit, so it tracks
  // the last rendered cfg (defensive — the two are identical for a normal click).
  const cfgRef = useRef(cfg);
  useEffect(() => { cfgRef.current = cfg; }, [cfg]);

  // Any edit disarms a pending cancel-confirm — the user is clearly still working.
  function mutate(fn: (n: Config) => void) {
    setConfirmCancel(false);
    setCfg((prev) => {
      const next = clone(prev);
      next.actions = next.actions || {};
      next.modes = next.modes || {};
      next.settings = next.settings || {};
      next.favorites = next.favorites || [];
      fn(next);
      return next;
    });
    setDirty(true);
  }

  function saveCfg() {
    setBusy(true);
    setMsg("Saving…");
    // From the ref, not the closure, so a mutate landing in the same tick as a
    // Save click can't make us persist stale config.
    call<any>("save_config", { config: stripTaskKeys(cfgRef.current) })
      .then((r) => {
        setBusy(false);
        if (r && r.ok) {
          setDirty(false);
          setConfirmCancel(false);
          setMsg("Saved");
          toast("Configuration saved");
          if (r.state) onSaved(r.state);
        } else {
          setMsg("Save failed: " + ((r && r.error) || "unknown error"));
          toast("Save failed");
        }
      })
      .catch((err) => {
        setBusy(false);
        setMsg("Error: " + errText(err));
      });
  }

  // Close button. Clean (not dirty) closes immediately. Dirty arms a confirm on
  // the first press and closes on the second.
  function onClosePressed() {
    if (!dirty) { closeModal?.(); return; }
    if (confirmCancel) { closeModal?.(); return; }
    setConfirmCancel(true);
    setMsg("Discard unsaved changes? Press Discard again to confirm.");
  }

  const tabProps = { cfg, mutate, busy };

  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <div style={{ fontSize: "1.4em", fontWeight: 700 }}>Edit configuration</div>
        <span style={{ fontSize: "0.8em", opacity: 0.7 }}>{dirty ? "Unsaved changes" : "Saved"}</span>
      </div>

      <Focusable flow-children="horizontal" style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
        <DialogButton disabled={busy || !dirty} onClick={saveCfg}>
          Save
        </DialogButton>
        {/* Closing discards the unsaved draft (edits only persist on Save). When
            dirty, the first press arms a confirm and the second discards. */}
        <DialogButton disabled={busy} onClick={onClosePressed}>
          {!dirty ? "Close" : confirmCancel ? "Discard — confirm" : "Cancel"}
        </DialogButton>
      </Focusable>
      {msg ? <div style={{ fontSize: "0.8em", opacity: 0.8, marginBottom: "8px" }}>{msg}</div> : null}

      {/* tab bar — horizontal flow so the d-pad/stick moves left↔right between tabs */}
      <Focusable flow-children="horizontal" style={{ display: "flex", gap: "4px", marginBottom: "10px" }}>
        <TabButton active={tab === "actions"} label="Actions" onClick={() => setTab("actions")} />
        <TabButton active={tab === "modes"} label="Modes" onClick={() => setTab("modes")} />
        <TabButton active={tab === "favorites"} label="Favorites" onClick={() => setTab("favorites")} />
        <TabButton active={tab === "fan"} label="Fan" onClick={() => setTab("fan")} />
        <TabButton active={tab === "tdp"} label="TDP" onClick={() => setTab("tdp")} />
        <TabButton active={tab === "sunshine"} label="Sunshine" onClick={() => setTab("sunshine")} />
        <TabButton active={tab === "triggers"} label="Triggers" onClick={() => setTab("triggers")} />
      </Focusable>

      {/* tab content */}
      <div style={{ maxHeight: "62vh", overflowY: "scroll", paddingRight: "6px" }}>
        {tab === "actions" ? (
          <ActionsTab {...tabProps} sel={selAction} setSel={setSelAction} profiles={profiles} installedPlugins={installedPlugins} />
        ) : null}
        {tab === "modes" ? <ModesTab {...tabProps} sel={selMode} setSel={setSelMode} /> : null}
        {tab === "favorites" ? <FavoritesTab {...tabProps} /> : null}
        {tab === "fan" ? <FanTab {...tabProps} sel={selFan} setSel={setSelFan} /> : null}
        {tab === "tdp" ? <TdpTab {...tabProps} sel={selTdp} setSel={setSelTdp} /> : null}
        {tab === "sunshine" ? <SunshineTab {...tabProps} installedPlugins={installedPlugins} live={sunshine} /> : null}
        {tab === "triggers" ? <TriggersTab {...tabProps} /> : null}
      </div>
    </ModalRoot>
  );
};
