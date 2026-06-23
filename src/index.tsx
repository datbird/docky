import { VFC, useState, useEffect } from "react";
import {
  definePlugin,
  ServerAPI,
  PanelSection,
  PanelSectionRow,
  ButtonItem,
  ToggleField,
  Field,
  showModal,
} from "decky-frontend-lib";
import { DockyState, RunResult, call, errText, setServer, summarize, toast } from "./util";
import { EditorModal } from "./components/EditorModal";

function DockIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 5h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5v2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v7h16V7H4z" />
    </svg>
  );
}

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
          <Field label="Environment" bottomSeparator="thick">
            {state.docked ? "Docked (external display)" : "Handheld"}
          </Field>
        </PanelSectionRow>
        <PanelSectionRow>
          <Field label="Active mode" bottomSeparator="thick">
            {activeName}
          </Field>
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
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={openEditor}>
            Edit configuration…
          </ButtonItem>
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

      <PanelSection>
        {msg ? (
          <PanelSectionRow>
            <div style={{ fontSize: "0.75em", opacity: 0.8, padding: "0 16px" }}>{msg}</div>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={refresh}>
            Refresh
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
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
