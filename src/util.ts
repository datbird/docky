import { ServerAPI } from "decky-frontend-lib";

// ---- config / state types (mirror py_modules/docky.py) ----

export interface Task {
  type: string;
  [k: string]: any;
}
export interface Action {
  name: string;
  tasks: Task[];
  continueOnError?: boolean;
}
export interface Mode {
  name: string;
  actions: string[];
}
export interface Settings {
  autoDockDetection?: boolean;
  dockedMode?: string;
  undockedMode?: string;
  pollSeconds?: number;
  // Dock-detection signals (see docky.py is_docked).
  requireExternalDisplay?: boolean;
  requireAcPower?: boolean;
  requireUsbHub?: boolean;
}
export interface Config {
  actions: Record<string, Action>;
  modes: Record<string, Mode>;
  settings: Settings;
  // Global per-task-type settings, keyed by task type (e.g. pcsx2_profile).
  taskSettings?: Record<string, Record<string, string>>;
}

export interface StateMode {
  id: string;
  name: string;
}
export interface StateAction {
  id: string;
  name: string;
  taskCount: number;
}
export interface DockyState {
  docked?: boolean;
  activeMode?: string;
  suggestedMode?: string;
  modes?: StateMode[];
  actions?: StateAction[];
  settings?: Settings;
  pcsx2_profiles?: string[];
  installed_plugins?: string[];
  sunshine?: { installed: boolean; running: boolean };
  error?: string;
}

export interface TaskResult {
  ok?: boolean;
  skipped?: boolean;
  message?: string;
}
export interface RunResult {
  ok?: boolean;
  message?: string;
  actions?: { results?: TaskResult[] }[];
  results?: TaskResult[];
}

// ---- backend plumbing ----

let server: ServerAPI | null = null;
export function setServer(s: ServerAPI): void {
  server = s;
}

export function call<T = any>(method: string, args?: any): Promise<T> {
  return server!.callPluginMethod(method, args || {}).then((res: any) => {
    if (res && res.success) return res.result as T;
    throw new Error((res && res.result) || "call failed");
  });
}

export function toast(body: string): void {
  try {
    server!.toaster.toast({ title: "Docky", body });
  } catch {
    /* noop */
  }
}

export function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}

export function errText(err: any): string {
  return err && err.message ? err.message : String(err);
}

export function slugify(name: string): string {
  const s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "item";
}

export function uniqueId(base: string, existing: Record<string, unknown>): string {
  let id = base;
  let n = 2;
  while (Object.prototype.hasOwnProperty.call(existing, id)) {
    id = base + "_" + n;
    n++;
  }
  return id;
}

// Human-readable summary of a run_action / activate_mode result.
export function summarize(result: RunResult | undefined): string {
  if (!result) return "Done";
  if (result.message) return result.message;
  const tasks: TaskResult[] = [];
  (result.actions || []).forEach((a) => (a.results || []).forEach((t) => tasks.push(t)));
  (result.results || []).forEach((t) => tasks.push(t));
  if (!tasks.length) return result.ok ? "OK" : "Failed";
  const fail = tasks.filter((t) => !t.ok);
  const skip = tasks.filter((t) => t.skipped);
  if (fail.length) return "Failed: " + fail[0].message;
  if (skip.length) return "Done (" + skip.length + " skipped): " + skip[0].message;
  return "Done — " + tasks.length + " task" + (tasks.length === 1 ? "" : "s") + " OK";
}
