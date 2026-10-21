import { VFC } from "react";
import { DialogButton, Field, ToggleField, DropdownItem } from "decky-frontend-lib";
import { slugify, uniqueId } from "../../util";
import { TaskField, taskDef, summarizeTask } from "../../taskdefs";
import { Card, TextRow } from "../inputs";
import { AddTask } from "./AddTask";
import { ListRow } from "./parts";
import { DrillProps, ProfileOpts } from "./types";

// Render a single task field bound to `value`, calling onChange with the new
// value. Used to edit a task already in an action (bool/select/profile/text).
function renderTaskField(
  f: TaskField,
  value: any,
  onChange: (v: any) => void,
  profiles: string[],
  profileOpts: ProfileOpts
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
  if (f.kind === "select" || f.kind === "fanProfile" || f.kind === "tdpProfile") {
    const opts =
      f.kind === "fanProfile" ? profileOpts.fan : f.kind === "tdpProfile" ? profileOpts.tdp : f.options || [];
    if (!opts.length) {
      return (
        <Field key={f.key} label={f.label}>
          <span style={{ opacity: 0.7 }}>No profiles yet</span>
        </Field>
      );
    }
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

export const ActionsTab: VFC<DrillProps & { profiles: string[]; installedPlugins: string[] }> = ({
  cfg,
  mutate,
  busy,
  sel,
  setSel,
  profiles,
  installedPlugins,
}) => {
  const cfgActions = cfg.actions || {};
  const cfgFanProfiles = cfg.fanProfiles || {};
  const cfgTdpProfiles = cfg.tdpProfiles || {};
  const actionIds = Object.keys(cfgActions);
  // Options for the saved-profile task fields. Fan adds an explicit "auto".
  const profileOpts: ProfileOpts = {
    fan: [{ data: "auto", label: "Auto (SteamOS)" }].concat(
      Object.keys(cfgFanProfiles).map((id) => ({ data: id, label: cfgFanProfiles[id].name || id }))
    ),
    tdp: Object.keys(cfgTdpProfiles).map((id) => ({ data: id, label: cfgTdpProfiles[id].name || id })),
  };

  function newAction() {
    mutate((n) => {
      const id = uniqueId(slugify("New action"), n.actions);
      n.actions[id] = { name: "New action", tasks: [] };
      // Select inside the same commit so the drill-in view opens on it.
      setSel(id);
    });
  }

  if (sel && cfgActions[sel]) {
    const aid = sel;
    const action = cfgActions[aid];
    return (
      <div>
        <DialogButton onClick={() => setSel(null)} style={{ marginBottom: "8px" }}>
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
                <Card key={task.__key || ti} title={d ? d.label : task.type}>
                  <div style={{ fontSize: "0.78em", opacity: 0.6, marginBottom: "4px" }}>
                    {summarizeTask(task)}
                  </div>
                  {fields.map((f) => renderTaskField(f, task[f.key], (v) => setField(f, v), profiles, profileOpts))}
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
            profileOpts={profileOpts}
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
                setSel(null);
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
              onClick={() => setSel(aid)}
            />
          );
        })
      )}
    </div>
  );
};
