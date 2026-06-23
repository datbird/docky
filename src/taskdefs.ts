import { Task } from "./util";

export type FieldKind = "text" | "bool" | "profile" | "select";

export interface TaskField {
  key: string;
  kind: FieldKind;
  label: string;
  def?: boolean;
  options?: { data: string; label: string }[];
}
// Global, per-task-type settings (NOT per-task) — edited via the gear next to
// the task-type dropdown, stored in config.taskSettings[type].
export interface TaskSettingField {
  key: string;
  label: string;
  description?: string;
  default?: string;
  placeholder?: string;
}

export interface TaskTypeDef {
  type: string;
  label: string;
  fields: TaskField[];
  summary: (t: Task) => string;
  // Curated, Docky-specific tasks (e.g. the PCSX2 profile swap) are grouped
  // behind a "Docky built-in task" picker; generic file/script ops are listed
  // directly. Add more built-ins by setting builtin: true.
  builtin?: boolean;
  // Type-level settings (shown behind the gear). Omit if the type has none.
  settings?: TaskSettingField[];
  // Requires another Decky plugin (by folder name) to be installed. If absent
  // from the running install, this task type is disabled in the picker.
  requiresPlugin?: string;
}

// Built-in task types. The PCSX2 controller-profile task is the marquee one;
// the rest are generic file/script ops. `fields` drives the add-task form.
export const TASK_DEFS: TaskTypeDef[] = [
  {
    type: "pcsx2_profile",
    label: "PCSX2 controller profile",
    builtin: true,
    fields: [
      { key: "profile", kind: "profile", label: "PCSX2 Controller Profile" },
      { key: "force", kind: "bool", label: "Force (apply even while PCSX2 runs)" },
    ],
    settings: [
      {
        key: "profiles_dir",
        label: "Controller profiles folder",
        description:
          "Folder holding the PCSX2 input-profile .ini files. Change this if PCSX2 isn't the RetroDECK Flatpak (EmuDeck, standalone, etc.). The main PCSX2.ini is found alongside it.",
        default: "~/.var/app/net.retrodeck.retrodeck/config/PCSX2/inputprofiles",
        placeholder: "~/.var/app/net.retrodeck.retrodeck/config/PCSX2/inputprofiles",
      },
    ],
    summary: (t) => "PCSX2 profile: " + (t.profile || "?"),
  },
  {
    type: "sunshine_composition",
    label: "Sunshine: force composition (fix docked stretch)",
    builtin: true,
    requiresPlugin: "decky-sunshine",
    fields: [
      { key: "enabled", kind: "bool", label: "Force composition on" },
    ],
    summary: (t) => "Sunshine composition: " + (t.enabled ? "on" : "off"),
  },
  {
    type: "sunshine_stop",
    label: "Sunshine: stop streaming",
    builtin: true,
    requiresPlugin: "decky-sunshine",
    fields: [],
    summary: () => "Sunshine: stop",
  },
  {
    type: "sunshine_encoder",
    label: "Sunshine: set video encoder",
    builtin: true,
    requiresPlugin: "decky-sunshine",
    fields: [
      {
        key: "encoder",
        kind: "select",
        label: "Encoder",
        options: [
          { data: "", label: "Auto" },
          { data: "vaapi", label: "VAAPI (recommended)" },
          { data: "vulkan", label: "Vulkan" },
          { data: "software", label: "Software (CPU)" },
        ],
      },
    ],
    summary: (t) => "Sunshine encoder: " + (t.encoder || "auto"),
  },
  {
    type: "run",
    label: "Run command",
    fields: [
      { key: "command", kind: "text", label: "Command (shell)" },
      { key: "cwd", kind: "text", label: "Working dir (optional)" },
    ],
    summary: (t) => "run: " + (t.command || (t.argv && t.argv.join(" ")) || "?"),
  },
  {
    type: "bash",
    label: "Bash script",
    fields: [
      { key: "script", kind: "text", label: "Script" },
      { key: "cwd", kind: "text", label: "Working dir (optional)" },
    ],
    summary: (t) => "bash: " + String(t.script || t.path || "").slice(0, 40),
  },
  {
    type: "python",
    label: "Python script",
    fields: [
      { key: "script", kind: "text", label: "Script" },
      { key: "cwd", kind: "text", label: "Working dir (optional)" },
    ],
    summary: (t) => "python: " + String(t.script || t.path || "").slice(0, 40),
  },
  {
    type: "copy",
    label: "Copy file",
    fields: [
      { key: "src", kind: "text", label: "Source" },
      { key: "dest", kind: "text", label: "Destination" },
    ],
    summary: (t) => "copy: " + t.src + " → " + t.dest,
  },
  {
    type: "move",
    label: "Move file",
    fields: [
      { key: "src", kind: "text", label: "Source" },
      { key: "dest", kind: "text", label: "Destination" },
    ],
    summary: (t) => "move: " + t.src + " → " + t.dest,
  },
  {
    type: "symlink",
    label: "Symlink",
    fields: [
      { key: "target", kind: "text", label: "Target" },
      { key: "link", kind: "text", label: "Link path" },
      { key: "replace", kind: "bool", label: "Replace if it exists", def: true },
    ],
    summary: (t) => "symlink: " + t.link + " → " + t.target,
  },
  {
    type: "write",
    label: "Write file",
    fields: [
      { key: "path", kind: "text", label: "Path" },
      { key: "content", kind: "text", label: "Content" },
      { key: "mode", kind: "text", label: "Mode (octal, optional)" },
    ],
    summary: (t) => "write: " + t.path,
  },
  {
    type: "delete",
    label: "Delete path",
    fields: [
      { key: "path", kind: "text", label: "Path" },
      { key: "recursive", kind: "bool", label: "Recursive (delete dirs)" },
    ],
    summary: (t) => "delete: " + t.path,
  },
];

// Curated Docky tasks (shown under the "Docky built-in task" sub-picker).
export const BUILTIN_DEFS: TaskTypeDef[] = TASK_DEFS.filter((d) => d.builtin);
// Generic file/script ops (listed directly in the task-type dropdown).
export const GENERIC_DEFS: TaskTypeDef[] = TASK_DEFS.filter((d) => !d.builtin);

export function taskDef(type: string): TaskTypeDef | null {
  for (const d of TASK_DEFS) if (d.type === type) return d;
  return null;
}

export function summarizeTask(t: Task): string {
  const d = taskDef(t.type);
  try {
    return d ? d.summary(t) : t.type + ": " + JSON.stringify(t);
  } catch {
    return t.type || "task";
  }
}
