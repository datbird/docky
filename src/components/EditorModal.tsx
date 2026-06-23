import { VFC, useState } from "react";
import {
  ModalRoot,
  DialogButton,
  Field,
  ToggleField,
  DropdownItem,
  Focusable,
} from "decky-frontend-lib";
import { Config, Task, call, clone, errText, slugify, toast, uniqueId } from "../util";
import { BUILTIN_DEFS, GENERIC_DEFS, taskDef, summarizeTask } from "../taskdefs";
import { Card, TextRow } from "./inputs";

type TabId = "actions" | "modes" | "autodock";

// Sentinel for the top-level dropdown entry that groups the curated Docky tasks.
const DOCKY_BUILTIN = "__docky_builtin__";

// Add-task form for one action: pick a type, fill its fields, append.
// Curated Docky tasks (e.g. PCSX2 profile) live behind a "Docky built-in task"
// entry with its own sub-dropdown; generic ops are listed directly.
const AddTask: VFC<{ profiles: string[]; busy: boolean; onAdd: (t: Task) => void }> = ({
  profiles,
  busy,
  onAdd,
}) => {
  const hasBuiltins = BUILTIN_DEFS.length > 0;
  const [top, setTop] = useState<string>(
    hasBuiltins ? DOCKY_BUILTIN : GENERIC_DEFS[0] ? GENERIC_DEFS[0].type : ""
  );
  const [builtinType, setBuiltinType] = useState<string>(BUILTIN_DEFS[0] ? BUILTIN_DEFS[0].type : "");
  const [vals, setVals] = useState<Record<string, any>>({});

  const type = top === DOCKY_BUILTIN ? builtinType : top;
  const def = taskDef(type)!;

  const topOptions = (hasBuiltins ? [{ data: DOCKY_BUILTIN, label: "Docky built-in task" }] : []).concat(
    GENERIC_DEFS.map((d) => ({ data: d.type, label: d.label }))
  );

  const setField = (k: string, val: any) => setVals({ ...vals, [k]: val });

  const add = () => {
    const task: Task = { type };
    def.fields.forEach((f) => {
      const val = vals[f.key];
      if (f.kind === "bool") {
        if (val) task[f.key] = true;
      } else if (val !== undefined && val !== "") {
        task[f.key] = val;
      }
    });
    if (type === "pcsx2_profile" && !task.profile && profiles.length) task.profile = profiles[0];
    onAdd(task);
    setVals({});
  };

  const valid = type === "pcsx2_profile" ? profiles.length > 0 : true;

  const fieldEls = def.fields.map((f) => {
    if (f.kind === "bool") {
      return (
        <ToggleField
          key={f.key}
          label={f.label}
          checked={!!vals[f.key]}
          onChange={(val) => setField(f.key, val)}
        />
      );
    }
    if (f.kind === "profile") {
      if (!profiles.length) {
        return (
          <Field key={f.key} label={f.label}>
            <span style={{ opacity: 0.7 }}>No PCSX2 profiles found</span>
          </Field>
        );
      }
      return (
        <DropdownItem
          key={f.key}
          label={f.label}
          rgOptions={profiles.map((p) => ({ data: p, label: p }))}
          selectedOption={vals[f.key] || profiles[0]}
          onChange={(o) => setField(f.key, o.data)}
        />
      );
    }
    return (
      <TextRow key={f.key} label={f.label} value={vals[f.key]} onChange={(val) => setField(f.key, val)} />
    );
  });

  return (
    <div style={{ marginTop: "8px", borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "8px" }}>
      <div style={{ fontWeight: 600, marginBottom: "2px" }}>Add a task</div>
      <DropdownItem
        label="Task type"
        rgOptions={topOptions}
        selectedOption={top}
        onChange={(o) => {
          setTop(o.data);
          setVals({});
        }}
      />
      {top === DOCKY_BUILTIN && BUILTIN_DEFS.length > 0 ? (
        <DropdownItem
          label="Built-in task"
          rgOptions={BUILTIN_DEFS.map((d) => ({ data: d.type, label: d.label }))}
          selectedOption={builtinType}
          onChange={(o) => {
            setBuiltinType(o.data);
            setVals({});
          }}
        />
      ) : null}
      {fieldEls}
      <DialogButton disabled={busy || !valid} onClick={add}>
        + Add task
      </DialogButton>
    </div>
  );
};

// One tab button in the top tab bar.
const TabButton: VFC<{ active: boolean; label: string; onClick: () => void }> = ({
  active,
  label,
  onClick,
}) => (
  <DialogButton
    onClick={onClick}
    style={{
      flex: 1,
      minWidth: 0,
      padding: "6px 4px",
      fontWeight: active ? 700 : 400,
      background: active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.04)",
      borderBottom: active ? "2px solid #1a9fff" : "2px solid transparent",
      borderRadius: "4px 4px 0 0",
    }}
  >
    {label}
  </DialogButton>
);

// A full-width row that drills into an item's detail when clicked.
const ListRow: VFC<{ label: string; sub?: string; onClick: () => void }> = ({ label, sub, onClick }) => (
  <DialogButton
    onClick={onClick}
    style={{
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "6px",
      textAlign: "left",
    }}
  >
    <span style={{ fontWeight: 600 }}>{label}</span>
    <span style={{ opacity: 0.6, fontSize: "0.85em" }}>{sub ? sub + " ›" : "›"}</span>
  </DialogButton>
);

export const EditorModal: VFC<{
  closeModal?: () => void;
  initialConfig: Config;
  profiles: string[];
  onSaved: (state: any) => void;
}> = ({ closeModal, initialConfig, profiles, onSaved }) => {
  const [cfg, setCfg] = useState<Config>(clone(initialConfig));
  const [dirty, setDirty] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [tab, setTab] = useState<TabId>("actions");
  const [selAction, setSelAction] = useState<string | null>(null);
  const [selMode, setSelMode] = useState<string | null>(null);

  function mutate(fn: (n: Config) => void) {
    const next = clone(cfg);
    next.actions = next.actions || {};
    next.modes = next.modes || {};
    next.settings = next.settings || {};
    fn(next);
    setCfg(next);
    setDirty(true);
  }

  function saveCfg() {
    setBusy(true);
    setMsg("Saving…");
    call<any>("save_config", { config: cfg })
      .then((r) => {
        setBusy(false);
        if (r && r.ok) {
          setDirty(false);
          setMsg("Saved");
          toast("Configuration saved");
          if (r.state) onSaved(r.state);
        } else {
          setMsg("Save failed: " + (r && r.error));
          toast("Save failed");
        }
      })
      .catch((err) => {
        setBusy(false);
        setMsg("Error: " + errText(err));
      });
  }

  function reload() {
    setBusy(true);
    call<any>("get_config", {})
      .then((r) => {
        setBusy(false);
        if (r && r.config) setCfg(r.config);
        setDirty(false);
        setSelAction(null);
        setSelMode(null);
        setMsg("Reloaded from file");
      })
      .catch((err) => {
        setBusy(false);
        setMsg("Error: " + errText(err));
      });
  }

  const cfgActions = cfg.actions || {};
  const cfgModes = cfg.modes || {};
  const actionIds = Object.keys(cfgActions);
  const modeIds = Object.keys(cfgModes);
  const modeOpts = [{ data: "", label: "(none)" }].concat(
    modeIds.map((mid) => ({ data: mid, label: cfgModes[mid].name || mid }))
  );

  function newAction() {
    const next = clone(cfg);
    next.actions = next.actions || {};
    next.modes = next.modes || {};
    next.settings = next.settings || {};
    const id = uniqueId(slugify("New action"), next.actions);
    next.actions[id] = { name: "New action", tasks: [] };
    setCfg(next);
    setDirty(true);
    setSelAction(id);
  }

  function newMode() {
    const next = clone(cfg);
    next.actions = next.actions || {};
    next.modes = next.modes || {};
    next.settings = next.settings || {};
    const id = uniqueId(slugify("New mode"), next.modes);
    next.modes[id] = { name: "New mode", actions: [] };
    setCfg(next);
    setDirty(true);
    setSelMode(id);
  }

  // ---- ACTIONS TAB ----
  function renderActions() {
    if (selAction && cfgActions[selAction]) {
      const aid = selAction;
      const action = cfgActions[aid];
      return (
        <div>
          <DialogButton onClick={() => setSelAction(null)} style={{ marginBottom: "8px" }}>
            ‹ All actions
          </DialogButton>
          <Card title={action.name || aid}>
            <TextRow
              label="Name"
              value={action.name}
              onChange={(val) => mutate((n) => { n.actions[aid].name = val; })}
            />
            <div style={{ fontWeight: 600, margin: "6px 0 2px" }}>Tasks</div>
            {(action.tasks || []).length === 0 ? (
              <div style={{ opacity: 0.6, margin: "4px 0" }}>No tasks yet</div>
            ) : (
              (action.tasks || []).map((task, ti) => (
                <Field key={ti} label={summarizeTask(task)} bottomSeparator="none">
                  <DialogButton
                    style={{ width: "8em" }}
                    disabled={busy}
                    onClick={() => mutate((n) => { n.actions[aid].tasks.splice(ti, 1); })}
                  >
                    Remove
                  </DialogButton>
                </Field>
              ))
            )}
            <AddTask
              profiles={profiles}
              busy={busy}
              onAdd={(task) =>
                mutate((n) => {
                  n.actions[aid].tasks = n.actions[aid].tasks || [];
                  n.actions[aid].tasks.push(task);
                })
              }
            />
            <div style={{ marginTop: "10px" }}>
              <DialogButton
                disabled={busy}
                onClick={() => {
                  mutate((n) => {
                    delete n.actions[aid];
                    Object.keys(n.modes).forEach((mid) => {
                      n.modes[mid].actions = (n.modes[mid].actions || []).filter((x) => x !== aid);
                    });
                  });
                  setSelAction(null);
                }}
              >
                Delete action
              </DialogButton>
            </div>
          </Card>
        </div>
      );
    }

    return (
      <div>
        <DialogButton onClick={newAction} disabled={busy} style={{ marginBottom: "10px" }}>
          + New action
        </DialogButton>
        {actionIds.length === 0 ? (
          <div style={{ opacity: 0.6 }}>No actions yet. Use “+ New action” to create one.</div>
        ) : (
          actionIds.map((aid) => {
            const a = cfgActions[aid];
            const n = (a.tasks || []).length;
            return (
              <ListRow
                key={aid}
                label={a.name || aid}
                sub={n + " task" + (n === 1 ? "" : "s")}
                onClick={() => setSelAction(aid)}
              />
            );
          })
        )}
      </div>
    );
  }

  // ---- MODES TAB ----
  function renderModes() {
    if (selMode && cfgModes[selMode]) {
      const mid = selMode;
      const mode = cfgModes[mid];
      const inMode = mode.actions || [];
      return (
        <div>
          <DialogButton onClick={() => setSelMode(null)} style={{ marginBottom: "8px" }}>
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
                    if (n.settings.dockedMode === mid) n.settings.dockedMode = "";
                    if (n.settings.undockedMode === mid) n.settings.undockedMode = "";
                  });
                  setSelMode(null);
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
            <ListRow key={mid} label={cfgModes[mid].name || mid} onClick={() => setSelMode(mid)} />
          ))
        )}
      </div>
    );
  }

  // ---- AUTO-DOCK TAB ----
  function renderAutoDock() {
    const strict = cfg.settings.requireExternalDisplay !== false; // default true
    return (
      <div>
        <div style={{ fontWeight: 700, margin: "2px 0 2px" }}>Dock detection</div>
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

        <div style={{ fontWeight: 700, margin: "12px 0 2px" }}>Mode mapping</div>
        <div style={{ fontSize: "0.8em", opacity: 0.6, marginBottom: "6px" }}>
          Which mode to switch to when docking / undocking.
        </div>
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
        <TextRow
          label="Dock poll interval (seconds)"
          value={String(cfg.settings.pollSeconds || 3)}
          onChange={(val) =>
            mutate((n) => {
              const num = parseInt(val, 10);
              n.settings.pollSeconds = isNaN(num) || num < 1 ? 1 : num;
            })
          }
        />
      </div>
    );
  }

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
        <DialogButton disabled={busy} onClick={reload}>
          {dirty ? "Discard" : "Reload"}
        </DialogButton>
        <DialogButton disabled={busy} onClick={() => closeModal?.()}>
          Close
        </DialogButton>
      </Focusable>
      {msg ? <div style={{ fontSize: "0.8em", opacity: 0.8, marginBottom: "8px" }}>{msg}</div> : null}

      {/* tab bar — horizontal flow so the d-pad/stick moves left↔right between tabs */}
      <Focusable flow-children="horizontal" style={{ display: "flex", gap: "4px", marginBottom: "10px" }}>
        <TabButton active={tab === "actions"} label="Actions" onClick={() => setTab("actions")} />
        <TabButton active={tab === "modes"} label="Modes" onClick={() => setTab("modes")} />
        <TabButton active={tab === "autodock"} label="Auto-dock mapping" onClick={() => setTab("autodock")} />
      </Focusable>

      {/* tab content */}
      <div style={{ maxHeight: "62vh", overflowY: "scroll", paddingRight: "6px" }}>
        {tab === "actions" ? renderActions() : null}
        {tab === "modes" ? renderModes() : null}
        {tab === "autodock" ? renderAutoDock() : null}
      </div>
    </ModalRoot>
  );
};
