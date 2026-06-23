import { VFC, useState } from "react";
import {
  ModalRoot,
  DialogButton,
  Field,
  ToggleField,
  DropdownItem,
} from "decky-frontend-lib";
import { Config, Task, call, clone, errText, slugify, toast, uniqueId } from "../util";
import { TASK_DEFS, taskDef, summarizeTask } from "../taskdefs";
import { Section, Card, TextRow } from "./inputs";

// Add-task form for one action: pick a type, fill its fields, append.
const AddTask: VFC<{ profiles: string[]; busy: boolean; onAdd: (t: Task) => void }> = ({
  profiles,
  busy,
  onAdd,
}) => {
  const [type, setType] = useState<string>("pcsx2_profile");
  const [vals, setVals] = useState<Record<string, any>>({});
  const def = taskDef(type)!;

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
    <div style={{ marginTop: "6px" }}>
      <DropdownItem
        label="Add task"
        rgOptions={TASK_DEFS.map((d) => ({ data: d.type, label: d.label }))}
        selectedOption={type}
        onChange={(o) => {
          setType(o.data);
          setVals({});
        }}
      />
      {fieldEls}
      <DialogButton disabled={busy || !valid} onClick={add}>
        + Add task
      </DialogButton>
    </div>
  );
};

// Inline name + create button (new action / new mode).
const NewItem: VFC<{ placeholder: string; busy: boolean; onCreate: (name: string) => void }> = ({
  placeholder,
  busy,
  onCreate,
}) => {
  const [name, setName] = useState<string>("");
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
      <div style={{ flex: 1 }}>
        <TextRow label={placeholder} value={name} onChange={setName} />
      </div>
      <DialogButton
        style={{ width: "8em" }}
        disabled={busy || !name.trim()}
        onClick={() => {
          onCreate(name.trim());
          setName("");
        }}
      >
        + Create
      </DialogButton>
    </div>
  );
};

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

  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <div style={{ maxHeight: "78vh", overflowY: "scroll", paddingRight: "6px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <div style={{ fontSize: "1.4em", fontWeight: 700 }}>Edit configuration</div>
          <span style={{ fontSize: "0.8em", opacity: 0.7 }}>{dirty ? "Unsaved changes" : "Saved"}</span>
        </div>

        <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
          <DialogButton disabled={busy || !dirty} onClick={saveCfg}>
            Save
          </DialogButton>
          <DialogButton disabled={busy} onClick={reload}>
            {dirty ? "Discard" : "Reload"}
          </DialogButton>
          <DialogButton disabled={busy} onClick={() => closeModal?.()}>
            Close
          </DialogButton>
        </div>
        {msg ? <div style={{ fontSize: "0.8em", opacity: 0.8, marginBottom: "10px" }}>{msg}</div> : null}

        {/* ---- Actions ---- */}
        <Section title="Actions" hint="An action is an ordered list of tasks.">
          {actionIds.length === 0 ? (
            <div style={{ opacity: 0.6 }}>No actions yet.</div>
          ) : (
            actionIds.map((aid) => {
              const action = cfgActions[aid];
              return (
                <Card key={aid} title={action.name || aid}>
                  <TextRow
                    label="Name"
                    value={action.name}
                    onChange={(val) => mutate((n) => { n.actions[aid].name = val; })}
                  />
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
                  <div style={{ marginTop: "6px" }}>
                    <DialogButton
                      disabled={busy}
                      onClick={() =>
                        mutate((n) => {
                          delete n.actions[aid];
                          Object.keys(n.modes).forEach((mid) => {
                            n.modes[mid].actions = (n.modes[mid].actions || []).filter((x) => x !== aid);
                          });
                        })
                      }
                    >
                      Delete action
                    </DialogButton>
                  </div>
                </Card>
              );
            })
          )}
          <NewItem
            placeholder="New action name"
            busy={busy}
            onCreate={(name) =>
              mutate((n) => {
                const id = uniqueId(slugify(name), n.actions);
                n.actions[id] = { name, tasks: [] };
              })
            }
          />
        </Section>

        {/* ---- Modes ---- */}
        <Section title="Modes" hint="A mode runs a set of actions (manually or on dock/undock).">
          {modeIds.length === 0 ? (
            <div style={{ opacity: 0.6 }}>No modes yet.</div>
          ) : (
            modeIds.map((mid) => {
              const mode = cfgModes[mid];
              const inMode = mode.actions || [];
              return (
                <Card key={mid} title={mode.name || mid}>
                  <TextRow
                    label="Name"
                    value={mode.name}
                    onChange={(val) => mutate((n) => { n.modes[mid].name = val; })}
                  />
                  <div style={{ fontSize: "0.75em", opacity: 0.7, margin: "4px 0" }}>Actions run in this mode:</div>
                  {actionIds.length === 0 ? (
                    <div style={{ opacity: 0.6 }}>No actions to assign</div>
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
                  <div style={{ marginTop: "6px" }}>
                    <DialogButton
                      disabled={busy}
                      onClick={() =>
                        mutate((n) => {
                          delete n.modes[mid];
                          if (n.settings.dockedMode === mid) n.settings.dockedMode = "";
                          if (n.settings.undockedMode === mid) n.settings.undockedMode = "";
                        })
                      }
                    >
                      Delete mode
                    </DialogButton>
                  </div>
                </Card>
              );
            })
          )}
          <NewItem
            placeholder="New mode name"
            busy={busy}
            onCreate={(name) =>
              mutate((n) => {
                const id = uniqueId(slugify(name), n.modes);
                n.modes[id] = { name, actions: [] };
              })
            }
          />
        </Section>

        {/* ---- Auto-dock mapping ---- */}
        <Section title="Auto-dock mapping" hint="Which mode to switch to when docking / undocking.">
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
        </Section>
      </div>
    </ModalRoot>
  );
};
