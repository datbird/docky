import { VFC, useState, useEffect, useRef } from "react";
import {
  definePlugin,
  ServerAPI,
  PanelSection,
  PanelSectionRow,
  ButtonItem,
  DialogButton,
  DropdownItem,
  Focusable,
  ToggleField,
  showModal,
} from "decky-frontend-lib";
import { DockyState, RunResult, call, errText, setServer, summarize, toast } from "./util";
import { Stepper } from "./components/inputs";
import { EditorModal } from "./components/EditorModal";
import { FanModal } from "./components/FanModal";
import { PairModal } from "./components/PairModal";
import { StatusModal } from "./components/StatusModal";

function DockIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 5h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5v2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v7h16V7H4z" />
    </svg>
  );
}

// The Docky brand mark: a navy badge with a white "dock" arch, a blue screen dot,
// and a blue dock cradle. Used as the plugin icon. Sized to fill the icon slot
// (badge near full-bleed, mark enlarged) so it reads at the same scale as other
// Decky plugin icons; the brighter badge + border keep it visible on the dark
// panel background, where the old darker navy blended in.
function DockyLogo() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 32 32">
      <defs>
        <linearGradient id="dockyBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a3548" />
          <stop offset="1" stopColor="#1a212d" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#dockyBg)" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="7.5" fill="none" stroke="#4a5a78" strokeWidth="1" />
      <path d="M8 24 V11 Q8 5.3 13.7 5.3 H18.3 Q24 5.3 24 11 V24"
            fill="none" stroke="#f1f4fa" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="14.8" r="3.4" fill="#5b7cf0" />
      <path d="M5.3 21.7 Q16 26.9 26.7 21.7" fill="none" stroke="#5b7cf0" strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}

// Small on/off "LED" shown on buttons whose task carries a live boolean state.
const StatusDot: VFC<{ on: boolean }> = ({ on }) => (
  <span
    style={{
      display: "inline-block",
      width: "10px",
      height: "10px",
      borderRadius: "50%",
      flexShrink: 0,
      background: on ? "#52d669" : "#555",
      boxShadow: on ? "0 0 6px #52d669" : "none",
    }}
  />
);

function InfoIcon() {
  return (
    <svg width="1.1em" height="1.1em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
    </svg>
  );
}

function ReloadIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.34.68.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.58-.24 1.12-.56 1.62-.94l2.39.96c.26.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h12v12H6z" />
    </svg>
  );
}

// Compact icon button for action rows. Omit `label` for an icon-only button.
const IconButton: VFC<{
  label?: string;
  flex?: number;
  disabled?: boolean;
  onClick: () => void;
  children: any;
}> = ({ label, flex, disabled, onClick, children }) => (
  <DialogButton
    disabled={disabled}
    onClick={onClick}
    style={{
      flex: flex ?? 1,
      minWidth: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "6px",
      padding: "6px",
    }}
  >
    {children}
    {label ? <span style={{ fontSize: "0.85em" }}>{label}</span> : null}
  </DialogButton>
);

// Clickable section header that expands/collapses the rows below it. Styled to
// read like a PanelSection title but works with the gamepad (it's a button).
const SectionHeader: VFC<{ title: string; open: boolean; onToggle: () => void }> = ({
  title,
  open,
  onToggle,
}) => (
  <DialogButton
    onClick={onToggle}
    style={{
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "4px 8px",
      minHeight: 0,
    }}
  >
    <span style={{ fontWeight: 700, fontSize: "0.85em", letterSpacing: "0.05em", textTransform: "uppercase", opacity: 0.85 }}>
      {title}
    </span>
    <span style={{ opacity: 0.7 }}>{open ? "▾" : "▸"}</span>
  </DialogButton>
);

const Content: VFC = () => {
  const [state, setState] = useState<DockyState | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [favOpen, setFavOpen] = useState<boolean>(false);
  const [triggersOpen, setTriggersOpen] = useState<boolean>(false);
  const [fanOpen, setFanOpen] = useState<boolean>(false);
  const [tdpOpen, setTdpOpen] = useState<boolean>(false);
  const [sunshineOpen, setSunshineOpen] = useState<boolean>(false);
  // Local draft for the TDP manual slider (committed on "Apply").
  const [tdpDraft, setTdpDraft] = useState<number | null>(null);

  function refresh(): Promise<void> {
    return call<DockyState>("get_state", {})
      .then(setState)
      .catch((err) => setState({ error: errText(err) }));
  }

  // Mirror `busy` into a ref so the polling interval can read the latest value
  // without re-subscribing.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // A modal (editor, fan curve, pairing, status) owns the source of truth while
  // it's open and calls back with the authoritative state when it closes. The
  // background poll must NOT run underneath it: a get_state landing mid-edit
  // would replace what the user is looking at with stale backend state, and — for
  // FanModal/PairModal, which don't guarantee they setState last — could win the
  // race against the modal's own onSaved. showModal returns a handle; we count
  // opens/closes so nested or rapid opens can't leave the poll wedged off.
  const modalCountRef = useRef(0);

  // Wrap showModal so every modal this panel opens increments the poll-pause
  // count for its lifetime, whatever closes it (Save, Cancel, back button).
  function openModal(node: any) {
    modalCountRef.current += 1;
    const inst = showModal(
      // decky's showModal injects closeModal; preserve any the node already has.
      node
    );
    // showModal doesn't give a close callback, so patch the returned instance's
    // Close to decrement. Guard so a double-close can't drive the count negative.
    const origClose = inst && inst.Close ? inst.Close.bind(inst) : null;
    if (inst) {
      let closed = false;
      inst.Close = () => {
        if (!closed) {
          closed = true;
          modalCountRef.current = Math.max(0, modalCountRef.current - 1);
        }
        if (origClose) origClose();
      };
    }
    return inst;
  }

  useEffect(() => {
    refresh();
    // Skip the periodic poll while a mutation is in flight OR a modal is open —
    // otherwise a refresh can land after an action (or mid-edit) and clobber it
    // with stale state (toggles snapping back, momentary flicker, an edit view
    // replaced underneath the user).
    const iv = setInterval(() => {
      if (!busyRef.current && modalCountRef.current === 0) refresh();
    }, 4000);
    return () => clearInterval(iv);
  }, []);

  // Every mutation handler funnels through here so the busy/refresh/error
  // discipline is defined once. `optimistic` lets a caller paint an expected
  // state immediately and hands back the rollback: on any failure we restore the
  // exact prior snapshot rather than leaving an optimistic value stranded until
  // the next poll (or forever, if the poll also fails). The response's own
  // `state` is authoritative when present; otherwise we refresh().
  function mutate(
    method: string,
    args: any,
    opts: {
      pending?: string;
      done?: (r: any) => string;
      toastResult?: boolean;
      optimistic?: () => () => void; // returns an undo fn
    } = {}
  ) {
    const undo = opts.optimistic ? opts.optimistic() : null;
    setBusy(true);
    if (opts.pending) setMsg(opts.pending);
    return call<{ result?: RunResult; message?: string; state?: DockyState }>(method, args)
      .then((r) => {
        setBusy(false);
        if (r && r.state) setState(r.state);
        else refresh();
        const text = opts.done ? opts.done(r) : (r && r.message) || (opts.pending || method);
        setMsg(text);
        if (opts.toastResult) toast(text);
        return r;
      })
      .catch((err) => {
        setBusy(false);
        if (undo) undo(); // revert the optimistic paint; the failure stands
        const text = "Error: " + errText(err);
        setMsg(text);
        if (opts.toastResult) toast(text);
        return undefined;
      });
  }

  function doCall(method: string, args: any, label: string) {
    mutate(method, args, {
      pending: label + "…",
      done: (r) => {
        const text = summarize(r && r.result);
        toast(text);
        return text;
      },
    });
  }

  function toggleTrigger(key: string, label: string, v: boolean) {
    mutate(
      "set_trigger",
      { key, enabled: v },
      {
        done: () => label + " " + (v ? "ON" : "OFF"),
        // Optimistically flip the switch so it doesn't visibly lag the (root)
        // backend round-trip; undo restores the prior value on failure.
        optimistic: () => {
          let prev: boolean | undefined;
          setState((s) => {
            if (!s) return s;
            prev = (s.settings as any)?.[key];
            return { ...s, settings: { ...(s.settings || {}), [key]: v } };
          });
          return () =>
            setState((s) =>
              s ? { ...s, settings: { ...(s.settings || {}), [key]: prev } } : s
            );
        },
      }
    );
  }

  function sunshineControl(
    method: "sunshine_start" | "sunshine_stop" | "sunshine_restart",
    verb: string
  ) {
    mutate(method, {}, {
      pending: verb + " Sunshine…",
      done: (r) => (r && r.message ? r.message : verb + " done"),
    });
  }

  // Fan/TDP quick controls and the Sunshine toggles: backend returns
  // {message,state}. For the toggles we paint optimistically and roll back on
  // error, so a rejected change doesn't leave the switch lying about reality.
  function fanTdpCall(method: string, args: any, label: string) {
    mutate(method, args, {
      pending: label + "…",
      done: (r) => (r && r.message ? r.message : label),
    });
  }

  // A Sunshine setting toggle keyed under state.sunshine.<key>. Optimistic with
  // rollback, matching the trigger toggles.
  function sunshineToggle(method: string, key: string, v: boolean, label: string) {
    mutate(method, { enabled: v }, {
      pending: label + "…",
      done: (r) => (r && r.message ? r.message : label),
      optimistic: () => {
        let prev: any;
        setState((s) => {
          if (!s) return s;
          prev = (s.sunshine as any)?.[key];
          return { ...s, sunshine: { ...(s.sunshine || {}), [key]: v } as any };
        });
        return () =>
          setState((s) =>
            s ? { ...s, sunshine: { ...(s.sunshine || {}), [key]: prev } as any } : s
          );
      },
    });
  }

  function setFanMode(mode: "auto" | "manual" | "curve") {
    fanTdpCall("set_fan_mode", { mode }, "Fan: " + mode);
  }

  function releaseControl() {
    // A deliberate one-shot action — toast so it's clearly acknowledged (the
    // inline status line is faint and far from the button, and when nothing was
    // being enforced there's no visible hardware change to confirm it worked).
    mutate("release_control", {}, {
      pending: "Handing Fan & TDP back to SteamOS…",
      done: (r) => (r && r.message) || "Handed Fan & TDP back to SteamOS",
      toastResult: true,
    });
  }

  function openEditor(initialTab?: string) {
    // Pause the poll for the whole fetch+modal lifetime, not just the fetch:
    // increment now, and hand a decrementing close down to the modal. (openModal
    // handles that; here we also cover the window between the click and the
    // config arriving.) Kept as its own count via openModal below.
    setBusy(true);
    call<any>("get_config", {})
      .then((r) => {
        setBusy(false);
        const config = r && r.config ? r.config : { actions: {}, modes: {}, settings: {} };
        openModal(
          <EditorModal
            initialConfig={config}
            initialTab={initialTab as any}
            profiles={(state && state.pcsx2_profiles) || []}
            installedPlugins={(state && state.installed_plugins) || []}
            onSaved={(st) => {
              if (st) setState(st);
              else refresh();
            }}
          />
        );
      })
      .catch((err) => {
        setBusy(false);
        setMsg("Error: " + errText(err));
      });
  }

  if (!state) {
    return (
      <PanelSection title="Docky">
        <PanelSectionRow>
          <div>Loading…</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }
  if (state.error) {
    return (
      <PanelSection title="Docky">
        <PanelSectionRow>
          <div style={{ color: "orange" }}>{state.error}</div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={refresh}>
            Retry
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const sett = state.settings || {};
  const modes = state.modes || [];
  const favorites = state.favorites || [];
  const fanProfiles = state.fanProfiles || [];
  const tdpProfiles = state.tdpProfiles || [];
  const fan = state.fan;
  const tdp = state.tdp;
  const sun = state.sunshine;
  // TDP label: a saved profile's name, else "Manual" only when Docky is actually
  // holding a cap — enforcing, or the live cap sits below the hardware max. If
  // neither, TDP has been handed back to SteamOS (e.g. via release_control, which
  // clears enforce/profile and lifts the cap to max), so show "SteamOS", not
  // "Manual".
  const tdpLabel = tdp?.profile
    ? (tdpProfiles.find((p) => p.id === tdp.profile)?.name || tdp.profile)
    : (!!tdp?.enforce ||
        (typeof tdp?.watts === "number" && typeof tdp?.max === "number" && tdp.watts < tdp.max))
      ? "Manual"
      : "SteamOS";
  const activeName = (() => {
    const found = modes.find((x) => x.id === state.activeMode);
    return found ? found.name : state.activeMode || "none";
  })();

  return (
    <>
      <PanelSection title="Docky">
        <PanelSectionRow>
          <Focusable flow-children="horizontal" style={{ display: "flex", gap: "8px" }}>
            <IconButton
              flex={0.5}
              disabled={busy}
              onClick={() => openModal(<StatusModal state={state} activeName={activeName} />)}
            >
              <InfoIcon />
            </IconButton>
            <IconButton label="Reload" disabled={busy} onClick={refresh}>
              <ReloadIcon />
            </IconButton>
            <IconButton label="Settings" disabled={busy} onClick={() => openEditor()}>
              <SettingsIcon />
            </IconButton>
          </Focusable>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            description="Fan → auto and TDP cap lifted; SteamOS/BIOS defaults take over"
            onClick={releaseControl}
          >
            ⏏ Hand Fan &amp; TDP control back to SteamOS
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection>
        <PanelSectionRow>
          <SectionHeader title="Favorites" open={favOpen} onToggle={() => setFavOpen(!favOpen)} />
        </PanelSectionRow>
        {!favOpen ? null : favorites.length ? (
          favorites.map((f) => {
            const isActive = f.kind === "mode" && f.id === state.activeMode;
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

      <PanelSection>
        <PanelSectionRow>
          <SectionHeader title="Sunshine" open={sunshineOpen} onToggle={() => setSunshineOpen(!sunshineOpen)} />
        </PanelSectionRow>
        {!sunshineOpen ? null : (
          <>
            <PanelSectionRow>
              <Focusable
                flow-children="horizontal"
                style={{ display: "flex", gap: "8px" }}
              >
                <IconButton
                  label="Pair"
                  flex={2}
                  disabled={busy || !(sun && sun.running)}
                  onClick={() =>
                    openModal(
                      <PairModal
                        credsStored={!!(sun && sun.credsStored)}
                        onState={(st) => st && setState(st)}
                      />
                    )
                  }
                >
                  <DockIcon />
                </IconButton>
                <IconButton
                  disabled={busy || !(sun && sun.running)}
                  onClick={() => sunshineControl("sunshine_restart", "Restarting")}
                >
                  <RestartIcon />
                </IconButton>
                <IconButton
                  disabled={busy || !(sun && sun.installed)}
                  onClick={() =>
                    sun && sun.running
                      ? sunshineControl("sunshine_stop", "Stopping")
                      : sunshineControl("sunshine_start", "Starting")
                  }
                >
                  {sun && sun.running ? <StopIcon /> : <PlayIcon />}
                </IconButton>
              </Focusable>
            </PanelSectionRow>
            <PanelSectionRow>
              <ToggleField
                label="Fix stretched image when docked"
                description="Forces gamescope composition; re-applied automatically after reboots."
                checked={!!(sun && sun.forceComposition)}
                disabled={busy}
                onChange={(v: boolean) =>
                  sunshineToggle("set_force_composition", "forceComposition", v, "Updating composition")
                }
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ToggleField
                label="HDR (Game Mode)"
                description="Enables HDR output; re-applied automatically after reboots. Display and content must support HDR."
                checked={!!(sun && sun.forceHdr)}
                disabled={busy}
                onChange={(v: boolean) =>
                  sunshineToggle("set_force_hdr", "forceHdr", v, "Updating HDR")
                }
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ToggleField
                label="Keep Sunshine running"
                // Defaults ON: watchdog is enabled unless the backend explicitly
                // sends watchdog:false. This is the one toggle that inverts (the
                // others default off via !!), because a missing value here should
                // read as "the safety net is on", not "off".
                description="Relaunch Sunshine automatically if it crashes."
                checked={!(sun && sun.watchdog === false)}
                disabled={busy}
                onChange={(v: boolean) =>
                  sunshineToggle("set_sunshine_watchdog", "watchdog", v, "Updating watchdog")
                }
              />
            </PanelSectionRow>
          </>
        )}
      </PanelSection>

      <PanelSection>
        <PanelSectionRow>
          <SectionHeader title="Fan" open={fanOpen} onToggle={() => setFanOpen(!fanOpen)} />
        </PanelSectionRow>
        {!fanOpen ? null : (
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
                    onClick={() => setFanMode(m)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: "6px 4px",
                      fontWeight: (fan?.mode || "auto") === m ? 700 : 400,
                      background: (fan?.mode || "auto") === m ? "rgba(91,124,240,0.35)" : "rgba(255,255,255,0.06)",
                      border: (fan?.mode || "auto") === m ? "1px solid #5b7cf0" : "1px solid transparent",
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
                onClick={() => openModal(<FanModal onSaved={(st) => { if (st) setState(st); else refresh(); }} />)}
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

      <PanelSection>
        <PanelSectionRow>
          <SectionHeader title="TDP" open={tdpOpen} onToggle={() => setTdpOpen(!tdpOpen)} />
        </PanelSectionRow>
        {!tdpOpen ? null : tdp?.available === false ? (
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

      <PanelSection>
        <PanelSectionRow>
          <SectionHeader title="Triggers" open={triggersOpen} onToggle={() => setTriggersOpen(!triggersOpen)} />
        </PanelSectionRow>
        {!triggersOpen
          ? null
          : [
              { key: "autoDockDetection", label: "Dock / undock", desc: "Switch modes when you dock or undock" },
              { key: "autoAcDetection", label: "AC power", desc: "Switch modes when AC power connects/disconnects" },
              { key: "autoControllerDetection", label: "External controller", desc: "Switch modes when a controller connects/disconnects" },
              { key: "autoResume", label: "Resume from sleep", desc: "Re-apply a mode when the Deck wakes" },
              { key: "autoStartup", label: "Startup", desc: "Apply a mode when Docky loads at boot" },
            ].map((t) => (
              <PanelSectionRow key={t.key}>
                <ToggleField
                  label={t.label}
                  description={t.desc}
                  checked={!!(sett as any)[t.key]}
                  disabled={busy}
                  onChange={(v) => toggleTrigger(t.key, t.label, v)}
                />
              </PanelSectionRow>
            ))}
        {triggersOpen ? (
          <PanelSectionRow>
            <div style={{ fontSize: "0.7em", opacity: 0.6, padding: "0 4px" }}>
              Map each trigger to a mode in Settings (gear) → Triggers.
            </div>
          </PanelSectionRow>
        ) : null}
      </PanelSection>

      {msg ? (
        <PanelSection>
          <PanelSectionRow>
            <div style={{ fontSize: "0.75em", opacity: 0.8, padding: "0 16px" }}>{msg}</div>
          </PanelSectionRow>
        </PanelSection>
      ) : null}
    </>
  );
};

export default definePlugin((serverApi: ServerAPI) => {
  setServer(serverApi);
  return {
    title: <div className="Title">Docky</div>,
    content: <Content />,
    icon: <DockyLogo />,
    onDismount() {},
  };
});
