import { VFC, useState } from "react";
import {
  ModalRoot,
  DialogButton,
  Field,
  ToggleField,
  DropdownItem,
  Focusable,
  showModal,
} from "decky-frontend-lib";
import { Task, nextTaskKey } from "../../util";
import { BUILTIN_DEFS, GENERIC_DEFS, TaskTypeDef, taskDef } from "../../taskdefs";
import { TextRow } from "../inputs";
import { ProfileOpts } from "./types";

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
export const AddTask: VFC<{
  profiles: string[];
  profileOpts: ProfileOpts;
  busy: boolean;
  onAdd: (t: Task) => void;
  taskSettings: Record<string, Record<string, string>>;
  onChangeTaskSetting: (type: string, key: string, value: string) => void;
  installedPlugins: string[];
}> = ({ profiles, profileOpts, busy, onAdd, taskSettings, onChangeTaskSetting, installedPlugins }) => {
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
  // taskDef can return null on a version skew (a saved type removed in an
  // update). Guard rather than assert (!) so a stale value renders a message
  // instead of throwing the whole editor.
  const def = taskDef(type);

  const topOptions = (hasBuiltins ? [{ data: DOCKY_BUILTIN, label: "Docky built-in task" }] : []).concat(
    GENERIC_DEFS.map((d) => ({ data: d.type, label: optLabel(d) }))
  );

  const setField = (k: string, val: any) => setVals({ ...vals, [k]: val });

  const add = () => {
    if (!def) return;
    const task: Task = { type, __key: nextTaskKey() };
    def.fields.forEach((f) => {
      const val = vals[f.key];
      if (f.kind === "bool") {
        // Honor the field's default when the user never touched the toggle.
        if (val ?? f.def) task[f.key] = true;
      } else if (val !== undefined && val !== "") {
        task[f.key] = val;
      } else if (f.kind === "select" && f.options && f.options.length) {
        // Untouched dropdown: persist the shown default (its first option). The
        // dropdown renders options[0] as selected, so the user did see this
        // value even if they didn't touch it. (Text fields, by contrast, are
        // omitted when empty — the asymmetry is intentional: a select always has
        // a meaningful default, an empty text box means "unset".)
        task[f.key] = f.options[0].data;
      } else if (f.kind === "fanProfile" && profileOpts.fan[0]) {
        task[f.key] = profileOpts.fan[0].data;
      } else if (f.kind === "tdpProfile" && profileOpts.tdp[0]) {
        task[f.key] = profileOpts.tdp[0].data;
      }
    });
    if (type === "pcsx2_profile" && !task.profile && profiles.length) task.profile = profiles[0];
    onAdd(task);
    setVals({});
  };

  const valid = !!def && pluginOk(def) && (type === "pcsx2_profile" ? profiles.length > 0 : true);

  const fieldEls = (def ? def.fields : []).map((f) => {
    if (f.kind === "bool") {
      return (
        <ToggleField
          key={f.key}
          label={f.label}
          checked={vals[f.key] ?? !!f.def}
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
    if (f.kind === "select" || f.kind === "fanProfile" || f.kind === "tdpProfile") {
      const opts =
        f.kind === "fanProfile" ? profileOpts.fan : f.kind === "tdpProfile" ? profileOpts.tdp : f.options || [];
      if (!opts.length) {
        return (
          <Field key={f.key} label={f.label}>
            <span style={{ opacity: 0.7 }}>No profiles yet — make one in the Fan/TDP tab</span>
          </Field>
        );
      }
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

  const hasSettings = !!(def && def.settings && def.settings.length);
  const openSettings = () =>
    def &&
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
      {def && !pluginOk(def) ? (
        <div style={{ color: "#e8a33d", fontSize: "0.8em", margin: "4px 0" }}>
          Requires the “{def.requiresPlugin}” plugin, which isn’t installed.
        </div>
      ) : !def ? (
        <div style={{ color: "#e8a33d", fontSize: "0.8em", margin: "4px 0" }}>
          Unknown task type “{type}”. It may belong to a newer version of Docky.
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
