import { Task } from "./util";

export type FieldKind = "text" | "bool" | "profile";

export interface TaskField {
  key: string;
  kind: FieldKind;
  label: string;
  def?: boolean;
}
export interface TaskTypeDef {
  type: string;
  label: string;
  fields: TaskField[];
  summary: (t: Task) => string;
}

// Built-in task types. The PCSX2 controller-profile task is the marquee one;
// the rest are generic file/script ops. `fields` drives the add-task form.
export const TASK_DEFS: TaskTypeDef[] = [
  {
    type: "pcsx2_profile",
    label: "PCSX2 controller profile",
    fields: [
      { key: "profile", kind: "profile", label: "Profile" },
      { key: "force", kind: "bool", label: "Force (apply even while PCSX2 runs)" },
    ],
    summary: (t) => "PCSX2 profile: " + (t.profile || "?"),
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
