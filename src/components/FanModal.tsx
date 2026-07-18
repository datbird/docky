import { VFC, useState, useEffect, useRef } from "react";
import {
  ModalRoot,
  DialogButton,
  Focusable,
  DropdownItem,
} from "decky-frontend-lib";
import { Config, CurvePoint, DockyState, FanStatus, call, clone, errText, slugify, toast, uniqueId } from "../util";
import { CurveEditor, normalizePoints } from "./CurveEditor";
import { TextRow, Stepper } from "./inputs";

type FanMode = "auto" | "manual" | "curve";

// Live editor for the *active* fan config, with quick apply of saved profiles
// and a "save current as profile" shortcut. Full profile management lives in the
// editor's Fan tab.
export const FanModal: VFC<{
  closeModal?: () => void;
  onSaved: (state: any) => void;
}> = ({ closeModal, onSaved }) => {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [mode, setMode] = useState<FanMode>("auto");
  const [manualRpm, setManualRpm] = useState<number>(3000);
  const [interpolate, setInterpolate] = useState<boolean>(true);
  const [points, setPoints] = useState<CurvePoint[]>([]);
  const [maxRpm, setMaxRpm] = useState<number>(8000);
  const [live, setLive] = useState<FanStatus | null>(null);
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [newName, setNewName] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [dirty, setDirty] = useState<boolean>(false);
  // Mirror `busy` so the live poll can skip while a save/apply is in flight.
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  function loadFrom(c: Config) {
    const s = c.settings || {};
    setCfg(c);
    setMode((s.fanMode as FanMode) || "auto");
    setManualRpm(typeof s.fanManualRpm === "number" ? s.fanManualRpm : 3000);
    // interpolate defaults ON: only an explicit false turns it off (matches the
    // backend's FanCurve.interpolate optional, which defaults true).
    setInterpolate(s.fanCurve?.interpolate !== false);
    setPoints((s.fanCurve?.points || []).map((p) => ({ temp: p.temp, rpm: p.rpm })));
    setProfiles(Object.keys(c.fanProfiles || {}).map((id) => ({ id, name: c.fanProfiles![id].name || id })));
    // A freshly loaded draft matches what's persisted; nothing to save yet.
    setDirty(false);
  }

  useEffect(() => {
    call<{ config: Config }>("get_config", {})
      .then((r) => loadFrom(r && r.config ? r.config : ({ actions: {}, modes: {}, settings: {} } as Config)))
      .catch((err) => setMsg("Error: " + errText(err)));
  }, []);

  useEffect(() => {
    let stop = false;
    function tick() {
      if (busyRef.current) return; // don't poll over an in-flight save/apply
      call<DockyState>("get_state", {})
        .then((st) => {
          if (stop || !st || !st.fan) return;
          setLive(st.fan);
          if (st.fan.maxRpm) setMaxRpm(st.fan.maxRpm);
        })
        .catch(() => {});
    }
    tick();
    const iv = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  // Persist active fan settings into the whole config, then apply immediately.
  //
  // The order is load-bearing: save_config() writes fanCurve.points, and
  // set_fan_mode(mode, rpm) does NOT carry the curve -- it re-reads it from the
  // just-saved config. So the save must land before the apply. save_config is
  // synchronous through the backend call (it fsyncs), so chaining the promises
  // is enough; don't reorder these.
  function save(applyMode: FanMode, applyRpm: number) {
    if (!cfg) return;
    setBusy(true);
    setMsg("Saving…");
    const next = clone(cfg);
    next.settings = next.settings || {};
    next.settings.fanMode = applyMode;
    next.settings.fanManualRpm = applyRpm;
    next.settings.fanCurve = { interpolate, points: normalizePoints(points) };
    next.settings.fanProfile = ""; // manual edit, not a saved profile
    let saved = false;
    call<any>("save_config", { config: next })
      .then((r) => {
        if (!(r && r.ok)) throw new Error((r && r.error) || "save failed");
        saved = true;
        setCfg(next);
        setDirty(false);
        return call<any>("set_fan_mode", { mode: applyMode, rpm: applyRpm });
      })
      .then((r) => {
        setBusy(false);
        setMsg(r && r.message ? r.message : "Applied");
        toast("Fan: " + (r && r.message ? r.message : applyMode));
        if (r && r.state) onSaved(r.state);
      })
      .catch((err) => {
        setBusy(false);
        // Distinguish "couldn't save at all" from "saved but the apply failed" --
        // in the latter the config IS persisted, so telling the user it failed
        // outright would make them think nothing happened and not retry.
        const text = errText(err);
        if (saved) {
          setMsg("Saved, but couldn't apply: " + text);
          toast("Fan saved but not applied");
        } else {
          setMsg("Error: " + text);
          toast("Fan save failed");
        }
      });
  }

  // Switching the mode tab. Auto and Manual apply on tap (their effect is fully
  // determined by the tap -- hand back to SteamOS, or hold the current manual
  // RPM). Curve does NOT: applying a curve has its own guarded button ("Save &
  // apply curve", disabled until the curve is valid), and auto-applying on tab
  // tap would bypass that check and could push a one-point / invalid curve.
  function pickMode(m: FanMode) {
    setMode(m);
    if (m === "curve") {
      setMsg("Edit the curve, then Save & apply.");
      return;
    }
    save(m, manualRpm);
  }

  // Apply a saved profile (loads it into the active config) and refresh the
  // draft. busy stays true across BOTH round-trips so the 1.5s poll can't fire
  // between the apply and the get_config and race loadFrom's setLive.
  function applyProfile(id: string) {
    setBusy(true);
    setMsg("Applying profile…");
    call<any>("apply_fan_profile", { profile_id: id })
      .then((r) => {
        if (r && r.state) onSaved(r.state);
        setMsg(r && r.message ? r.message : "Applied");
        return call<{ config: Config }>("get_config", {});
      })
      .then((r) => { if (r && r.config) loadFrom(r.config); setBusy(false); })
      .catch((err) => { setBusy(false); setMsg("Error: " + errText(err)); });
  }

  // Save the current active settings as a new named profile.
  function saveAsProfile() {
    if (!cfg) return;
    const name = newName.trim();
    if (!name) { setMsg("Enter a profile name first"); return; }
    setBusy(true);
    setMsg("Saving profile…");
    const next = clone(cfg);
    next.fanProfiles = next.fanProfiles || {};
    const id = uniqueId(slugify(name), next.fanProfiles);
    next.fanProfiles[id] = {
      name,
      mode,
      manualRpm,
      curve: { interpolate, points: normalizePoints(points) },
    };
    call<any>("save_config", { config: next })
      .then((r) => {
        setBusy(false);
        if (!(r && r.ok)) throw new Error((r && r.error) || "save failed");
        loadFrom(next);
        setNewName("");
        setMsg("Saved profile '" + name + "'");
        toast("Saved fan profile");
        if (r.state) onSaved(r.state);
      })
      .catch((err) => { setBusy(false); setMsg("Error: " + errText(err)); });
  }

  // Plain render helper (not an inline component) so the buttons keep a stable
  // element type across renders and don't remount / drop gamepad focus.
  const modeButton = (m: FanMode, label: string) => (
    <DialogButton
      disabled={busy}
      onClick={() => pickMode(m)}
      style={{
        flex: 1, minWidth: 0, padding: "8px 4px",
        fontWeight: mode === m ? 700 : 400,
        background: mode === m ? "rgba(91,124,240,0.35)" : "rgba(255,255,255,0.06)",
        border: mode === m ? "1px solid #5b7cf0" : "1px solid transparent",
      }}
    >
      {label}
    </DialogButton>
  );

  const unavailable = live && live.available === false;
  // A usable curve needs at least two points at distinct temperatures.
  const curveOk = normalizePoints(points).length >= 2;
  const profileOpts = [{ data: "", label: profiles.length ? "Apply a profile…" : "(no profiles yet)" }]
    .concat(profiles.map((p) => ({ data: p.id, label: p.name })));

  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
        <div style={{ fontSize: "1.4em", fontWeight: 700 }}>Fan control</div>
        <div style={{ fontSize: "0.95em", opacity: 0.9 }}>
          {typeof live?.tempC === "number" ? `${live.tempC}°C` : "—°C"} ·{" "}
          {typeof live?.rpm === "number" ? `${live.rpm} RPM` : "— RPM"}
          {typeof live?.target === "number" && live.mode !== "auto" ? ` (→${live.target})` : ""}
        </div>
      </div>

      {unavailable ? (
        <div style={{ color: "#e8a33d", fontSize: "0.85em", marginBottom: "8px" }}>
          No controllable fan found on this device.
        </div>
      ) : null}

      {profiles.length ? (
        <DropdownItem
          label="Saved profiles"
          rgOptions={profileOpts}
          selectedOption={""}
          onChange={(o) => o.data && applyProfile(o.data)}
        />
      ) : null}

      <Focusable flow-children="horizontal" style={{ display: "flex", gap: "6px", margin: "8px 0 10px" }}>
        {modeButton("auto", "Auto")}
        {modeButton("curve", "Curve")}
        {modeButton("manual", "Manual")}
      </Focusable>

      {mode === "manual" ? (
        <div style={{ marginBottom: "10px" }}>
          <Stepper label="Manual fan speed" value={manualRpm} min={0} max={maxRpm} step={100} coarse={1000} disabled={busy}
            onChange={(v) => { setManualRpm(v); setDirty(true); }} />
          <DialogButton disabled={busy} onClick={() => save("manual", manualRpm)}>
            Apply {manualRpm} RPM
          </DialogButton>
        </div>
      ) : null}

      {mode === "curve" ? (
        <div>
          <CurveEditor
            points={points}
            interpolate={interpolate}
            maxRpm={maxRpm}
            tempC={live?.tempC}
            rpm={live?.rpm}
            busy={busy}
            onPoints={(p) => { setPoints(p); setDirty(true); }}
            onInterpolate={(b) => { setInterpolate(b); setDirty(true); }}
          />
          <DialogButton disabled={busy || !dirty || !curveOk} onClick={() => save("curve", manualRpm)} style={{ marginTop: "6px" }}>
            Save & apply curve
          </DialogButton>
        </div>
      ) : null}

      {mode === "auto" ? (
        <div style={{ opacity: 0.7, fontSize: "0.85em", margin: "4px 0 10px" }}>
          SteamOS controls the fan. Pick Curve or Manual to take over.
        </div>
      ) : null}

      {mode !== "auto" ? (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", marginTop: "8px", paddingTop: "8px" }}>
          <div style={{ fontWeight: 600, marginBottom: "2px" }}>Save current as a profile</div>
          <TextRow label="Profile name" value={newName} onChange={setNewName} />
          <DialogButton disabled={busy || !newName.trim()} onClick={saveAsProfile}>
            Save as profile
          </DialogButton>
        </div>
      ) : null}

      {msg ? <div style={{ fontSize: "0.8em", opacity: 0.8, margin: "8px 0" }}>{msg}</div> : null}

      <DialogButton disabled={busy} onClick={() => closeModal?.()} style={{ marginTop: "6px" }}>
        Close
      </DialogButton>
    </ModalRoot>
  );
};
