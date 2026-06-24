import { VFC, useState, useEffect } from "react";
import {
  ModalRoot,
  DialogButton,
  Field,
  ToggleField,
  DropdownItem,
  Focusable,
  showModal,
} from "decky-frontend-lib";
import { Config, Favorite, Task, call, clone, errText, slugify, toast, uniqueId } from "../util";
import { BUILTIN_DEFS, GENERIC_DEFS, TaskField, TaskTypeDef, taskDef, summarizeTask } from "../taskdefs";
import { Card, TextRow } from "./inputs";

type TabId = "actions" | "modes" | "favorites" | "sunshine" | "autodock";

interface SunshineInfo {
  installed: boolean;
  installedVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

// Sentinel for the top-level dropdown entry that groups the curated Docky tasks.
const DOCKY_BUILTIN = "__docky_builtin__";

function GearIcon() {
  return (
    <svg width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.34.68.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.58-.24 1.12-.56 1.62-.94l2.39.96c.26.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
    </svg>
  );
}

// Popup window for a task type's global settings (e.g. the PCSX2 profiles path).
// Keeps its own field state for display; each edit also calls onChange so the
// parent editor's draft (config.taskSettings[type]) updates and marks dirty.
const TaskSettingsModal: VFC<{
  closeModal?: () => void;
  def: TaskTypeDef;
  initial: Record<string, string>;
  onChange: (key: string, value: string) => void;
}> = ({ closeModal, def, initial, onChange }) => {
  const [vals, setVals] = useState<Record<string, string>>({ ...initial });
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <div style={{ fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" }}>{def.label} — settings</div>
      {(def.settings || []).map((s) => (
        <div key={s.key} style={{ marginBottom: "10px" }}>
          <TextRow
            label={s.label}
            value={vals[s.key] ?? ""}
            onChange={(v) => {
              setVals({ ...vals, [s.key]: v });
              onChange(s.key, v);
            }}
          />
          {s.description ? (
            <div style={{ fontSize: "0.75em", opacity: 0.6, marginTop: "2px" }}>{s.description}</div>
          ) : null}
          {s.default ? (
            <div style={{ fontSize: "0.7em", opacity: 0.5, marginTop: "2px" }}>
              Default: {s.default}
            </div>
          ) : null}
        </div>
      ))}
      <DialogButton onClick={() => closeModal?.()}>Done</DialogButton>
    </ModalRoot>
  );
};

// Add-task form for one action: pick a type, fill its fields, append.
// Curated Docky tasks (e.g. PCSX2 profile) live behind a "Docky built-in task"
// entry with its own sub-dropdown; generic ops are listed directly.
const AddTask: VFC<{
  profiles: string[];
  busy: boolean;
  onAdd: (t: Task) => void;
  taskSettings: Record<string, Record<string, string>>;
  onChangeTaskSetting: (type: string, key: string, value: string) => void;
  installedPlugins: string[];
}> = ({ profiles, busy, onAdd, taskSettings, onChangeTaskSetting, installedPlugins }) => {
  const pluginOk = (d: { requiresPlugin?: string }) =>
    !d.requiresPlugin || installedPlugins.indexOf(d.requiresPlugin) !== -1;
  const optLabel = (d: { label: string; requiresPlugin?: string }) =>
    pluginOk(d) ? d.label : d.label + ` (needs ${d.requiresPlugin})`;
  const hasBuiltins = BUILTIN_DEFS.length > 0;
  const [top, setTop] = useState<string>(
    hasBuiltins ? DOCKY_BUILTIN : GENERIC_DEFS[0] ? GENERIC_DEFS[0].type : ""
  );
  const [builtinType, setBuiltinType] = useState<string>(BUILTIN_DEFS[0] ? BUILTIN_DEFS[0].type : "");
  const [vals, setVals] = useState<Record<string, any>>({});

  const type = top === DOCKY_BUILTIN ? builtinType : top;
  const def = taskDef(type)!;

  const topOptions = (hasBuiltins ? [{ data: DOCKY_BUILTIN, label: "Docky built-in task" }] : []).concat(
    GENERIC_DEFS.map((d) => ({ data: d.type, label: optLabel(d) }))
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
      } else if (f.kind === "select" && f.options && f.options.length) {
        // Untouched dropdown: persist the shown default (its first option).
        task[f.key] = f.options[0].data;
      }
    });
    if (type === "pcsx2_profile" && !task.profile && profiles.length) task.profile = profiles[0];
    onAdd(task);
    setVals({});
  };

  const valid = pluginOk(def) && (type === "pcsx2_profile" ? profiles.length > 0 : true);

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
    if (f.kind === "select") {
      const opts = f.options || [];
      return (
        <DropdownItem
          key={f.key}
          label={f.label}
          rgOptions={opts}
          selectedOption={vals[f.key] ?? (opts[0] ? opts[0].data : "")}
          onChange={(o) => setField(f.key, o.data)}
        />
      );
    }
    return (
      <TextRow key={f.key} label={f.label} value={vals[f.key]} onChange={(val) => setField(f.key, val)} />
    );
  });

  const hasSettings = !!(def.settings && def.settings.length);
  const openSettings = () =>
    showModal(
      <TaskSettingsModal
        def={def}
        initial={taskSettings[type] || {}}
        onChange={(k, v) => onChangeTaskSetting(type, k, v)}
      />
    );
  // Gear next to the task-type dropdown; grayed unless this type has settings.
  const gear = (
    <DialogButton
      disabled={busy || !hasSettings}
      onClick={openSettings}
      style={{ minWidth: 0, padding: "6px 10px", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <GearIcon />
    </DialogButton>
  );

  return (
    <div style={{ marginTop: "8px", borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "8px" }}>
      <div style={{ fontWeight: 600, marginBottom: "2px" }}>Add a task</div>
      {top === DOCKY_BUILTIN && BUILTIN_DEFS.length > 0 ? (
        <>
          <DropdownItem
            label="Task type"
            rgOptions={topOptions}
            selectedOption={top}
            onChange={(o) => {
              setTop(o.data);
              setVals({});
            }}
          />
          <Focusable flow-children="horizontal" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <DropdownItem
                label="Built-in task"
                rgOptions={BUILTIN_DEFS.map((d) => ({ data: d.type, label: optLabel(d) }))}
                selectedOption={builtinType}
                onChange={(o) => {
                  setBuiltinType(o.data);
                  setVals({});
                }}
              />
            </div>
            {gear}
          </Focusable>
        </>
      ) : (
        <Focusable flow-children="horizontal" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <DropdownItem
              label="Task type"
              rgOptions={topOptions}
              selectedOption={top}
              onChange={(o) => {
                setTop(o.data);
                setVals({});
              }}
            />
          </div>
          {gear}
        </Focusable>
      )}
      {!pluginOk(def) ? (
        <div style={{ color: "#e8a33d", fontSize: "0.8em", margin: "4px 0" }}>
          Requires the “{def.requiresPlugin}” plugin, which isn’t installed.
        </div>
      ) : (
        fieldEls
      )}
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

// Render a single task field bound to `value`, calling onChange with the new
// value. Used to edit a task already in an action (bool/select/profile/text).
function renderTaskField(
  f: TaskField,
  value: any,
  onChange: (v: any) => void,
  profiles: string[]
) {
  if (f.kind === "bool") {
    return (
      <ToggleField key={f.key} label={f.label} checked={!!value} onChange={(v) => onChange(v)} />
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
        selectedOption={value || profiles[0]}
        onChange={(o) => onChange(o.data)}
      />
    );
  }
  if (f.kind === "select") {
    const opts = f.options || [];
    return (
      <DropdownItem
        key={f.key}
        label={f.label}
        rgOptions={opts}
        selectedOption={value ?? (opts[0] ? opts[0].data : "")}
        onChange={(o) => onChange(o.data)}
      />
    );
  }
  return <TextRow key={f.key} label={f.label} value={value ?? ""} onChange={(v) => onChange(v)} />;
}

// Pick an action/mode (encoded "kind:id") not yet favorited, and add it.
const AddFavorite: VFC<{
  options: { data: string; label: string }[];
  busy: boolean;
  onAdd: (value: string) => void;
}> = ({ options, busy, onAdd }) => {
  const [sel, setSel] = useState<string>(options[0] ? options[0].data : "");
  // Keep the selection valid as the option list shrinks after each add.
  const cur = options.some((o) => o.data === sel) ? sel : options[0] ? options[0].data : "";
  return (
    <Focusable flow-children="horizontal" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
      <div style={{ flex: 1 }}>
        <DropdownItem
          label="Item"
          rgOptions={options}
          selectedOption={cur}
          onChange={(o) => setSel(o.data)}
        />
      </div>
      <DialogButton disabled={busy || !cur} onClick={() => cur && onAdd(cur)}>
        + Add
      </DialogButton>
    </Focusable>
  );
};

// Small fixed-width button for the favorite reorder/remove controls.
const MiniButton: VFC<{ disabled?: boolean; width: string; onClick: () => void; children: any }> = ({
  disabled,
  width,
  onClick,
  children,
}) => (
  <DialogButton
    disabled={disabled}
    onClick={onClick}
    style={{ minWidth: 0, width, padding: "6px 4px", textAlign: "center" }}
  >
    {children}
  </DialogButton>
);

export const EditorModal: VFC<{
  closeModal?: () => void;
  initialConfig: Config;
  profiles: string[];
  installedPlugins: string[];
  onSaved: (state: any) => void;
}> = ({ closeModal, initialConfig, profiles, installedPlugins, onSaved }) => {
  const [cfg, setCfg] = useState<Config>(clone(initialConfig));
  const [dirty, setDirty] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [tab, setTab] = useState<TabId>("actions");
  const [selAction, setSelAction] = useState<string | null>(null);
  const [selMode, setSelMode] = useState<string | null>(null);

  // Sunshine tab (live actions, not part of the config draft).
  const [sunInfo, setSunInfo] = useState<SunshineInfo | null>(null);
  const [sunBusy, setSunBusy] = useState<boolean>(false);
  const [sunMsg, setSunMsg] = useState<string>("");

  function refreshSunshine() {
    setSunBusy(true);
    setSunMsg("Checking flathub…");
    call<SunshineInfo>("sunshine_version_info")
      .then((r) => {
        setSunBusy(false);
        setSunInfo(r);
        setSunMsg("");
      })
      .catch((err) => {
        setSunBusy(false);
        setSunMsg("Error: " + errText(err));
      });
  }

  function doSunshine(method: string, verb: string) {
    setSunBusy(true);
    setSunMsg(verb + " Sunshine… (this can take a minute)");
    call<any>(method)
      .then((r) => {
        setSunBusy(false);
        if (r && r.info) setSunInfo(r.info);
        if (r && r.state) onSaved(r.state);
        setSunMsg(r && r.message ? r.message : verb + " done");
      })
      .catch((err) => {
        setSunBusy(false);
        setSunMsg("Error: " + errText(err));
      });
  }

  // Check versions the first time the Sunshine tab is opened.
  useEffect(() => {
    if (tab === "sunshine" && !sunInfo && !sunBusy) refreshSunshine();
  }, [tab]);

  function mutate(fn: (n: Config) => void) {
    const next = clone(cfg);
    next.actions = next.actions || {};
    next.modes = next.modes || {};
    next.settings = next.settings || {};
    next.favorites = next.favorites || [];
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
              (action.tasks || []).map((task, ti) => {
                const d = taskDef(task.type);
                const fields = d ? d.fields : [];
                const setField = (f: TaskField, value: any) =>
                  mutate((n) => {
                    const t = n.actions[aid].tasks[ti];
                    if (f.kind === "bool") {
                      if (value) t[f.key] = true;
                      else delete t[f.key];
                    } else if (value === "" || value === undefined) {
                      delete t[f.key];
                    } else {
                      t[f.key] = value;
                    }
                  });
                return (
                  <Card key={ti} title={d ? d.label : task.type}>
                    <div style={{ fontSize: "0.78em", opacity: 0.6, marginBottom: "4px" }}>
                      {summarizeTask(task)}
                    </div>
                    {fields.map((f) => renderTaskField(f, task[f.key], (v) => setField(f, v), profiles))}
                    <DialogButton
                      style={{ marginTop: "6px" }}
                      disabled={busy}
                      onClick={() => mutate((n) => { n.actions[aid].tasks.splice(ti, 1); })}
                    >
                      Remove task
                    </DialogButton>
                  </Card>
                );
              })
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
              taskSettings={cfg.taskSettings || {}}
              onChangeTaskSetting={(type, key, value) =>
                mutate((n) => {
                  n.taskSettings = n.taskSettings || {};
                  n.taskSettings[type] = n.taskSettings[type] || {};
                  n.taskSettings[type][key] = value;
                })
              }
              installedPlugins={installedPlugins}
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

  // ---- FAVORITES TAB ----
  function renderFavorites() {
    const favs = cfg.favorites || [];
    const key = (f: Favorite) => f.kind + ":" + f.id;
    const have: Record<string, boolean> = {};
    favs.forEach((f) => (have[key(f)] = true));
    const options = actionIds
      .filter((id) => !have["action:" + id])
      .map((id) => ({ data: "action:" + id, label: "Action — " + (cfgActions[id].name || id) }))
      .concat(
        modeIds
          .filter((id) => !have["mode:" + id])
          .map((id) => ({ data: "mode:" + id, label: "Mode — " + (cfgModes[id].name || id) }))
      );

    function swap(i: number, j: number) {
      mutate((n) => {
        const a = n.favorites!;
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
      });
    }

    return (
      <div>
        <div style={{ fontWeight: 700, margin: "2px 0 6px" }}>Favorites</div>
        <div style={{ fontSize: "0.8em", opacity: 0.6, marginBottom: "8px" }}>
          Pinned actions and modes appear in the panel’s Favorites section, in this order.
          Use ▲▼ to sort.
        </div>
        {favs.length === 0 ? (
          <div style={{ opacity: 0.6, marginBottom: "8px" }}>No favorites yet.</div>
        ) : (
          favs.map((f, i) => {
            const item = f.kind === "action" ? cfgActions[f.id] : cfgModes[f.id];
            const name = item ? item.name || f.id : f.id;
            const tag = f.kind === "action" ? "Action" : "Mode";
            return (
              <Field
                key={key(f) + "_" + i}
                label={tag + ": " + name + (item ? "" : " (missing)")}
                bottomSeparator="none"
              >
                <Focusable flow-children="horizontal" style={{ display: "flex", gap: "4px" }}>
                  <MiniButton width="3em" disabled={busy || i === 0} onClick={() => swap(i, i - 1)}>
                    ▲
                  </MiniButton>
                  <MiniButton
                    width="3em"
                    disabled={busy || i === favs.length - 1}
                    onClick={() => swap(i, i + 1)}
                  >
                    ▼
                  </MiniButton>
                  <MiniButton
                    width="5.5em"
                    disabled={busy}
                    onClick={() => mutate((n) => { n.favorites!.splice(i, 1); })}
                  >
                    Remove
                  </MiniButton>
                </Focusable>
              </Field>
            );
          })
        )}
        <div style={{ fontWeight: 600, margin: "12px 0 2px" }}>Add a favorite</div>
        {options.length === 0 ? (
          <div style={{ opacity: 0.6 }}>
            {actionIds.length + modeIds.length === 0
              ? "Create actions or modes first."
              : "Everything is already favorited."}
          </div>
        ) : (
          <AddFavorite
            options={options}
            busy={busy}
            onAdd={(value) =>
              mutate((n) => {
                const idx = value.indexOf(":");
                const kind = value.slice(0, idx) as Favorite["kind"];
                const id = value.slice(idx + 1);
                n.favorites = n.favorites || [];
                n.favorites.push({ kind, id });
              })
            }
          />
        )}
      </div>
    );
  }

  // ---- SUNSHINE TAB ----
  function renderSunshine() {
    const info = sunInfo;
    const InfoRow: VFC<{ label: string; value: string }> = ({ label, value }) => (
      <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
        <span style={{ opacity: 0.7 }}>{label}</span>
        <span style={{ fontWeight: 600 }}>{value || "—"}</span>
      </div>
    );
    return (
      <div>
        <div style={{ fontWeight: 700, margin: "2px 0 6px" }}>Sunshine</div>
        <div style={{ fontSize: "0.8em", opacity: 0.6, marginBottom: "10px" }}>
          Docky installs Sunshine from Flathub (the official LizardByte build) and
          keeps it updated from there. It isn’t installed until you enable it here.
        </div>

        {!info ? (
          <div style={{ opacity: 0.6 }}>{sunBusy ? "Checking…" : "—"}</div>
        ) : (
          <>
            <InfoRow label="Status" value={info.installed ? "Installed" : "Not installed"} />
            <InfoRow label="Current version" value={info.installedVersion} />
            <InfoRow label="Latest version" value={info.latestVersion} />
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
          {info && !info.installed ? (
            <DialogButton disabled={sunBusy} onClick={() => doSunshine("sunshine_install", "Installing")}>
              Install &amp; enable Sunshine
            </DialogButton>
          ) : (
            <DialogButton
              disabled={sunBusy || !(info && info.updateAvailable)}
              onClick={() => doSunshine("sunshine_update", "Updating")}
            >
              Update Sunshine
            </DialogButton>
          )}
          <DialogButton disabled={sunBusy} onClick={refreshSunshine}>
            Refresh
          </DialogButton>
        </Focusable>
        {sunMsg ? (
          <div style={{ fontSize: "0.8em", opacity: 0.8, marginTop: "10px" }}>{sunMsg}</div>
        ) : null}
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
        <TabButton active={tab === "favorites"} label="Favorites" onClick={() => setTab("favorites")} />
        <TabButton active={tab === "sunshine"} label="Sunshine" onClick={() => setTab("sunshine")} />
        <TabButton active={tab === "autodock"} label="Auto-dock" onClick={() => setTab("autodock")} />
      </Focusable>

      {/* tab content */}
      <div style={{ maxHeight: "62vh", overflowY: "scroll", paddingRight: "6px" }}>
        {tab === "actions" ? renderActions() : null}
        {tab === "modes" ? renderModes() : null}
        {tab === "favorites" ? renderFavorites() : null}
        {tab === "sunshine" ? renderSunshine() : null}
        {tab === "autodock" ? renderAutoDock() : null}
      </div>
    </ModalRoot>
  );
};
