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
  autostartSunshine?: boolean;
  sunshineEngine?: string;
  // additional triggers
  autoAcDetection?: boolean;
  acMode?: string;
  noAcMode?: string;
  autoControllerDetection?: boolean;
  controllerConnectMode?: string;
  controllerDisconnectMode?: string;
  autoResume?: boolean;
  resumeMode?: string;
  autoStartup?: boolean;
  startupMode?: string;
  // fan control (Fantastic-style curve engine)
  fanMode?: "auto" | "manual" | "curve";
  fanManualRpm?: number;
  fanCurve?: FanCurve;
  fanProfile?: string;
  // TDP
  tdpWatts?: number;
  tdpEnforce?: boolean;
  tdpProfile?: string;
}
export interface FanProfile {
  name: string;
  mode?: "auto" | "manual" | "curve";
  manualRpm?: number;
  curve?: FanCurve;
}
export interface TdpProfile {
  name: string;
  watts: number;
}
export interface CurvePoint {
  temp: number;
  rpm: number;
}
export interface FanCurve {
  interpolate?: boolean;
  points?: CurvePoint[];
}
export interface FanStatus {
  mode?: "auto" | "manual" | "curve";
  tempC?: number | null;
  rpm?: number | null;
  target?: number | null;
  manualRpm?: number;
  interpolate?: boolean;
  points?: CurvePoint[];
  available?: boolean;
  maxRpm?: number;
  profile?: string;
}
export interface TdpStatus {
  watts?: number | null;
  setWatts?: number;
  max?: number;
  enforce?: boolean;
  profile?: string;
  available?: boolean;
}
export interface ProfileRef {
  id: string;
  name: string;
  watts?: number;
}
export interface Favorite {
  kind: "action" | "mode";
  id: string;
}
export interface Config {
  actions: Record<string, Action>;
  modes: Record<string, Mode>;
  settings: Settings;
  // Global per-task-type settings, keyed by task type (e.g. pcsx2_profile).
  taskSettings?: Record<string, Record<string, string>>;
  // Ordered list of pinned actions/modes shown in the panel's Favorites section.
  favorites?: Favorite[];
  // Saved fan/TDP presets, keyed by id.
  fanProfiles?: Record<string, FanProfile>;
  tdpProfiles?: Record<string, TdpProfile>;
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
export interface StateFavorite {
  kind: "action" | "mode";
  id: string;
  name: string;
  missing?: boolean;
  // Live on/off state for action favorites whose action has a stateful task
  // (e.g. force-composition). null/undefined when the item has no readable state.
  status?: boolean | null;
  // Verb the action performs ("On"/"Off"/"Toggle"), used as the button prefix
  // instead of "Run:". null/undefined for plain actions.
  verb?: string | null;
}
export interface DockyState {
  docked?: boolean;
  activeMode?: string;
  suggestedMode?: string;
  modes?: StateMode[];
  actions?: StateAction[];
  favorites?: StateFavorite[];
  settings?: Settings;
  pcsx2_profiles?: string[];
  installed_plugins?: string[];
  sunshine?: {
    installed: boolean;
    running: boolean;
    credsStored?: boolean;
    engine?: string;
    resolvedEngine?: string;
    forceComposition?: boolean;
    watchdog?: boolean;
  };
  fan?: FanStatus;
  tdp?: TdpStatus;
  fanProfiles?: ProfileRef[];
  tdpProfiles?: ProfileRef[];
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

// Tasks have no stable id, so we tag each with a client-only `__key` for React
// list identity (index keys reuse the wrong DOM when a task is removed). Keys are
// assigned on load and stripped before save so they never reach config.json.
let _taskSeq = 0;
export function nextTaskKey(): string {
  return "tk" + ++_taskSeq;
}
export function withTaskKeys(cfg: Config): Config {
  Object.keys(cfg.actions || {}).forEach((aid) => {
    (cfg.actions[aid].tasks || []).forEach((t) => {
      if (!t.__key) t.__key = nextTaskKey();
    });
  });
  return cfg;
}
export function stripTaskKeys(cfg: Config): Config {
  const c = clone(cfg);
  Object.keys(c.actions || {}).forEach((aid) => {
    (c.actions[aid].tasks || []).forEach((t) => {
      delete t.__key;
    });
  });
  return c;
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
  if (fail.length) return "Failed: " + (fail[0].message || "task failed");
  if (skip.length) return "Done (" + skip.length + " skipped): " + (skip[0].message || "");
  return "Done — " + tasks.length + " task" + (tasks.length === 1 ? "" : "s") + " OK";
}
