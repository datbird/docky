import { VFC, useState, useEffect } from "react";
import {
  definePlugin,
  ServerAPI,
  PanelSection,
  PanelSectionRow,
  ButtonItem,
  DialogButton,
  Focusable,
  ToggleField,
  showModal,
} from "decky-frontend-lib";
import { DockyState, RunResult, call, errText, setServer, summarize, toast } from "./util";
import { EditorModal } from "./components/EditorModal";
import { PairModal } from "./components/PairModal";
import { StatusModal } from "./components/StatusModal";

function DockIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 5h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5v2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v7h16V7H4z" />
    </svg>
  );
}

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

const Content: VFC = () => {
  const [state, setState] = useState<DockyState | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");

  function refresh(): Promise<void> {
    return call<DockyState>("get_state", {})
      .then(setState)
      .catch((err) => setState({ error: errText(err) }));
  }

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 4000);
    return () => clearInterval(iv);
  }, []);

  function doCall(method: string, args: any, label: string) {
    setBusy(true);
    setMsg(label + "…");
    call<{ result?: RunResult; state?: DockyState }>(method, args)
      .then((r) => {
        setBusy(false);
        const text = summarize(r && r.result);
        setMsg(text);
        toast(text);
        if (r && r.state) setState(r.state);
        else refresh();
      })
      .catch((err) => {
        setBusy(false);
        const text = "Error: " + errText(err);
        setMsg(text);
        toast(text);
      });
  }

  function toggleAuto(v: boolean) {
    setBusy(true);
    call<{ state?: DockyState }>("set_auto_dock", { enabled: v })
      .then((r) => {
        setBusy(false);
        if (r && r.state) setState(r.state);
        else refresh();
        setMsg("Auto Dock Detection " + (v ? "ON" : "OFF"));
      })
      .catch((err) => {
        setBusy(false);
        setMsg("Error: " + errText(err));
      });
  }

  function toggleAutostartSunshine(v: boolean) {
    setBusy(true);
    call<{ state?: DockyState }>("set_autostart_sunshine", { enabled: v })
      .then((r) => {
        setBusy(false);
        if (r && r.state) setState(r.state);
        else refresh();
        setMsg("Start Sunshine at boot " + (v ? "ON" : "OFF"));
      })
      .catch((err) => {
        setBusy(false);
        setMsg("Error: " + errText(err));
      });
  }

  function sunshineControl(
    method: "sunshine_start" | "sunshine_stop" | "sunshine_restart",
    verb: string
  ) {
    setBusy(true);
    setMsg(verb + " Sunshine…");
    call<{ ok?: boolean; message?: string; state?: DockyState }>(method, {})
      .then((r) => {
        setBusy(false);
        if (r && r.state) setState(r.state);
        else refresh();
        setMsg(r && r.message ? r.message : verb + " done");
      })
      .catch((err) => {
        setBusy(false);
        setMsg("Error: " + errText(err));
      });
  }

  function openEditor() {
    setBusy(true);
    call<any>("get_config", {})
      .then((r) => {
        setBusy(false);
        const config = r && r.config ? r.config : { actions: {}, modes: {}, settings: {} };
        showModal(
          <EditorModal
            initialConfig={config}
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
  const actions = state.actions || [];
  const activeName = (() => {
    const found = modes.filter((x) => x.id === state.activeMode)[0];
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
              onClick={() =>
                showModal(
                  <StatusModal state={state} activeName={activeName} />
                )
              }
            >
              <InfoIcon />
            </IconButton>
            <IconButton label="Reload" disabled={busy} onClick={refresh}>
              <ReloadIcon />
            </IconButton>
            <IconButton label="Settings" disabled={busy} onClick={openEditor}>
              <SettingsIcon />
            </IconButton>
          </Focusable>
        </PanelSectionRow>
        <PanelSectionRow>
          <Focusable
            flow-children="horizontal"
            style={{ display: "flex", gap: "8px" }}
          >
            <IconButton
              label="Pair"
              flex={2}
              disabled={busy}
              onClick={() =>
                showModal(
                  <PairModal
                    credsStored={
                      !!(state.sunshine && state.sunshine.credsStored)
                    }
                    onState={(st) => st && setState(st)}
                  />
                )
              }
            >
              <DockIcon />
            </IconButton>
            <IconButton
              disabled={busy || !(state.sunshine && state.sunshine.running)}
              onClick={() => sunshineControl("sunshine_restart", "Restarting")}
            >
              <RestartIcon />
            </IconButton>
            <IconButton
              disabled={busy || !(state.sunshine && state.sunshine.installed)}
              onClick={() =>
                state.sunshine && state.sunshine.running
                  ? sunshineControl("sunshine_stop", "Stopping")
                  : sunshineControl("sunshine_start", "Starting")
              }
            >
              {state.sunshine && state.sunshine.running ? (
                <StopIcon />
              ) : (
                <PlayIcon />
              )}
            </IconButton>
          </Focusable>
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Start Sunshine at boot"
            description="Launch Sunshine when Docky loads after a reboot"
            checked={sett.autostartSunshine !== false}
            disabled={busy}
            onChange={toggleAutostartSunshine}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Auto Dock Detection"
            description="Auto-switch modes when you dock/undock"
            checked={!!sett.autoDockDetection}
            disabled={busy}
            onChange={toggleAuto}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Modes">
        {modes.length ? (
          modes.map((mode) => {
            const isActive = mode.id === state.activeMode;
            const isSugg = mode.id === state.suggestedMode && !isActive;
            const desc = isActive ? "Active" : isSugg ? "Suggested for this environment" : undefined;
            return (
              <PanelSectionRow key={"m_" + mode.id}>
                <ButtonItem
                  layout="below"
                  disabled={busy}
                  description={desc}
                  onClick={() => doCall("activate_mode", { mode_id: mode.id }, "Switching to " + mode.name)}
                >
                  {(isActive ? "✓ " : "") + mode.name}
                </ButtonItem>
              </PanelSectionRow>
            );
          })
        ) : (
          <PanelSectionRow>
            <div style={{ opacity: 0.7 }}>No modes defined</div>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Run Action">
        {actions.length ? (
          actions.map((a) => (
            <PanelSectionRow key={"a_" + a.id}>
              <ButtonItem
                layout="below"
                disabled={busy}
                description={a.taskCount + " task" + (a.taskCount === 1 ? "" : "s")}
                onClick={() => doCall("run_action", { action_id: a.id }, "Running " + a.name)}
              >
                {"Run: " + a.name}
              </ButtonItem>
            </PanelSectionRow>
          ))
        ) : (
          <PanelSectionRow>
            <div style={{ opacity: 0.7 }}>No actions defined</div>
          </PanelSectionRow>
        )}
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
    icon: <DockIcon />,
    onDismount() {},
  };
});
