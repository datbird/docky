import { VFC, useState, useEffect, useRef } from "react";
import {
  definePlugin,
  ServerAPI,
  PanelSection,
  PanelSectionRow,
  ButtonItem,
  Focusable,
  showModal,
} from "decky-frontend-lib";
import { DockyState, RunResult, call, errText, setServer, summarize, toast } from "./util";
import { EditorModal } from "./components/EditorModal";
import { StatusModal } from "./components/StatusModal";
import { DockyLogo, IconButton, InfoIcon, ReloadIcon, SettingsIcon } from "./components/panel/icons";
import { FavoritesSection } from "./components/panel/FavoritesSection";
import { SunshineSection } from "./components/panel/SunshineSection";
import { FanSection } from "./components/panel/FanSection";
import { TdpSection } from "./components/panel/TdpSection";
import { TriggersSection } from "./components/panel/TriggersSection";

const Content: VFC = () => {
  const [state, setState] = useState<DockyState | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");

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

  const modes = state.modes || [];
  const activeName = (() => {
    const found = modes.find((x) => x.id === state.activeMode);
    return found ? found.name : state.activeMode || "none";
  })();
  const onSaved = (st: DockyState) => {
    if (st) setState(st);
    else refresh();
  };

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
            description="Fan → auto and TDP back to the stock cap; SteamOS defaults take over"
            onClick={releaseControl}
          >
            ⏏ Hand Fan &amp; TDP control back to SteamOS
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <FavoritesSection
        favorites={state.favorites || []}
        activeMode={state.activeMode}
        busy={busy}
        doCall={doCall}
      />
      <SunshineSection
        sun={state.sunshine}
        busy={busy}
        openModal={openModal}
        setState={setState}
        sunshineControl={sunshineControl}
        sunshineToggle={sunshineToggle}
      />
      <FanSection
        fan={state.fan}
        fanProfiles={state.fanProfiles || []}
        busy={busy}
        fanTdpCall={fanTdpCall}
        openModal={openModal}
        openEditor={openEditor}
        onSaved={onSaved}
      />
      <TdpSection
        tdp={state.tdp}
        tdpProfiles={state.tdpProfiles || []}
        busy={busy}
        fanTdpCall={fanTdpCall}
        openEditor={openEditor}
      />
      <TriggersSection settings={state.settings || {}} busy={busy} toggleTrigger={toggleTrigger} />

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
