(function (react, deckyFrontendLib) {
    'use strict';

    // ---- backend plumbing ----
    let server = null;
    function setServer(s) {
        server = s;
    }
    function call(method, args) {
        return server.callPluginMethod(method, args || {}).then((res) => {
            if (res && res.success)
                return res.result;
            throw new Error((res && res.result) || "call failed");
        });
    }
    function toast(body) {
        try {
            server.toaster.toast({ title: "Docky", body });
        }
        catch {
            /* noop */
        }
    }
    function clone(o) {
        return JSON.parse(JSON.stringify(o));
    }
    function errText(err) {
        return err && err.message ? err.message : String(err);
    }
    function slugify(name) {
        const s = String(name || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
        return s || "item";
    }
    function uniqueId(base, existing) {
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
    function nextTaskKey() {
        return "tk" + ++_taskSeq;
    }
    function withTaskKeys(cfg) {
        Object.keys(cfg.actions || {}).forEach((aid) => {
            (cfg.actions[aid].tasks || []).forEach((t) => {
                if (!t.__key)
                    t.__key = nextTaskKey();
            });
        });
        return cfg;
    }
    function stripTaskKeys(cfg) {
        const c = clone(cfg);
        Object.keys(c.actions || {}).forEach((aid) => {
            (c.actions[aid].tasks || []).forEach((t) => {
                delete t.__key;
            });
        });
        return c;
    }
    // Human-readable summary of a run_action / activate_mode result.
    function summarize(result) {
        if (!result)
            return "Done";
        if (result.message)
            return result.message;
        const tasks = [];
        (result.actions || []).forEach((a) => (a.results || []).forEach((t) => tasks.push(t)));
        (result.results || []).forEach((t) => tasks.push(t));
        if (!tasks.length)
            return result.ok ? "OK" : "Failed";
        const fail = tasks.filter((t) => !t.ok);
        const skip = tasks.filter((t) => t.skipped);
        if (fail.length)
            return "Failed: " + (fail[0].message || "task failed");
        if (skip.length)
            return "Done (" + skip.length + " skipped): " + (skip[0].message || "");
        return "Done — " + tasks.length + " task" + (tasks.length === 1 ? "" : "s") + " OK";
    }

    // A bordered card wrapping one editable Action or Mode.
    const Card = ({ title, children }) => (window.SP_REACT.createElement("div", { style: {
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: "6px",
            padding: "8px 12px",
            marginBottom: "10px",
            background: "rgba(255,255,255,0.03)",
        } },
        window.SP_REACT.createElement("div", { style: { fontWeight: 600, marginBottom: "4px" } }, title),
        children));
    const TextRow = (props) => {
        const extra = props.password ? { bIsPassword: true } : {};
        return (window.SP_REACT.createElement(deckyFrontendLib.Field, { label: props.label, childrenLayout: "below", bottomSeparator: "none" },
            window.SP_REACT.createElement(deckyFrontendLib.TextField, { ...extra, value: props.value || "", onChange: (e) => props.onChange(e.target.value) })));
    };
    // A numeric stepper built only from DialogButton/Field/Focusable (all present in
    // the runtime decky-frontend-lib global). Used instead of DFL's SliderField,
    // which isn't exposed by the injected DFL global (rendering it crashes the panel
    // with React #130). Optional `coarse` adds «/» buttons for big jumps.
    const Stepper = ({ label, value, min, max, step, coarse, unit, disabled, onChange }) => {
        const clamp = (v) => Math.max(min, Math.min(max, v));
        // A plain render helper, NOT an inline component. Defining a component inside
        // Stepper would give it a new type identity every render, so React would
        // unmount/remount the buttons on each value change and GamepadUI would drop
        // focus mid-press. Returning <DialogButton> elements keeps the type stable.
        const btn = (delta, txt) => (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: disabled || (delta < 0 ? value <= min : value >= max), onClick: () => onChange(clamp(value + delta)), style: { minWidth: 0, flex: 1, padding: "6px 4px", textAlign: "center" } }, txt));
        return (window.SP_REACT.createElement(deckyFrontendLib.Field, { label: label, childrenLayout: "below", bottomSeparator: "none" },
            window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "6px", alignItems: "center" } },
                coarse ? btn(-coarse, "«") : null,
                btn(-step, "−"),
                window.SP_REACT.createElement("div", { style: { flex: 1.6, textAlign: "center", fontWeight: 600 } },
                    value,
                    unit || ""),
                btn(step, "+"),
                coarse ? btn(coarse, "»") : null)));
    };

    // Built-in task types. The PCSX2 controller-profile task is the marquee one;
    // the rest are generic file/script ops. `fields` drives the add-task form.
    const TASK_DEFS = [
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
                    description: "Folder holding the PCSX2 input-profile .ini files. Change this if PCSX2 isn't the RetroDECK Flatpak (EmuDeck, standalone, etc.). The main PCSX2.ini is found alongside it.",
                    default: "~/.var/app/net.retrodeck.retrodeck/config/PCSX2/inputprofiles",
                },
            ],
            summary: (t) => "PCSX2 profile: " + (t.profile || "?"),
        },
        {
            type: "sunshine_start",
            label: "Sunshine: start streaming",
            builtin: true,
            fields: [],
            summary: () => "Sunshine: start",
        },
        {
            type: "sunshine_restart",
            label: "Sunshine: restart streaming",
            builtin: true,
            fields: [],
            summary: () => "Sunshine: restart",
        },
        {
            type: "sunshine_stop",
            label: "Sunshine: stop streaming",
            builtin: true,
            fields: [],
            summary: () => "Sunshine: stop",
        },
        {
            type: "sunshine_composition",
            label: "Sunshine: force composition (fix docked stretch)",
            builtin: true,
            fields: [
                {
                    key: "mode",
                    kind: "select",
                    label: "Action",
                    options: [
                        { data: "on", label: "On" },
                        { data: "off", label: "Off" },
                        { data: "toggle", label: "Toggle" },
                    ],
                },
            ],
            summary: (t) => "Sunshine composition: " + (t.mode || (t.enabled ? "on" : "off")),
        },
        {
            type: "sunshine_hdr",
            label: "Display: HDR on/off (Game Mode)",
            builtin: true,
            fields: [
                {
                    key: "mode",
                    kind: "select",
                    label: "Action",
                    options: [
                        { data: "on", label: "On" },
                        { data: "off", label: "Off" },
                        { data: "toggle", label: "Toggle" },
                    ],
                },
            ],
            summary: (t) => "HDR: " + (t.mode || (t.enabled ? "on" : "off")),
        },
        {
            type: "sunshine_encoder",
            label: "Sunshine: set video encoder",
            builtin: true,
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
            type: "audio_output",
            label: "Audio: switch output device (fix dock audio)",
            builtin: true,
            fields: [
                {
                    key: "target",
                    kind: "select",
                    label: "Output",
                    options: [
                        { data: "hdmi", label: "HDMI / external (dock)" },
                        { data: "speakers", label: "Internal speakers" },
                        { data: "headphones", label: "Headphones" },
                    ],
                },
            ],
            summary: (t) => "Audio output: " + (t.target || "?"),
        },
        {
            type: "builtin_controller",
            label: "Controller: built-in (fix dock controller order)",
            builtin: true,
            fields: [
                {
                    key: "mode",
                    kind: "select",
                    label: "Built-in controller",
                    options: [
                        { data: "on", label: "On (enabled)" },
                        { data: "off", label: "Off (disabled — let external be P1)" },
                        { data: "toggle", label: "Toggle" },
                    ],
                },
            ],
            summary: (t) => "Built-in controller: " + (t.mode || (t.enabled ? "on" : "off")),
        },
        {
            type: "tdp",
            label: "Performance: set TDP watts (docked power)",
            builtin: true,
            fields: [
                { key: "profile", kind: "tdpProfile", label: "TDP profile" },
                { key: "watts", kind: "text", label: "…or custom watts (e.g. 15)" },
            ],
            summary: (t) => t.profile
                ? "TDP profile: " + t.profile
                : "TDP: " + (t.watts ? t.watts + "W" : "?"),
        },
        {
            type: "fan",
            label: "Performance: fan control (profile / manual / auto)",
            builtin: true,
            fields: [{ key: "profile", kind: "fanProfile", label: "Fan profile" }],
            summary: (t) => "Fan: " + (t.profile || "auto"),
        },
        {
            type: "release_control",
            label: "Performance: hand control back to SteamOS (fan + TDP defaults)",
            builtin: true,
            fields: [],
            summary: () => "Release control to SteamOS",
        },
        {
            type: "flatpak_update",
            label: "Maintenance: update Flatpak app(s)",
            builtin: true,
            fields: [{ key: "app", kind: "text", label: "App id (blank = all)" }],
            summary: (t) => "Flatpak update: " + (t.app || "all"),
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
    const BUILTIN_DEFS = TASK_DEFS.filter((d) => d.builtin);
    // Generic file/script ops (listed directly in the task-type dropdown).
    const GENERIC_DEFS = TASK_DEFS.filter((d) => !d.builtin);
    function taskDef(type) {
        for (const d of TASK_DEFS)
            if (d.type === type)
                return d;
        return null;
    }
    function summarizeTask(t) {
        const d = taskDef(t.type);
        try {
            return d ? d.summary(t) : t.type + ": " + JSON.stringify(t);
        }
        catch {
            return t.type || "task";
        }
    }

    // Temperature axis bounds for the graph / sliders.
    const T_MIN = 30;
    const T_MAX = 95;
    function sortPoints(pts) {
        return [...pts].sort((a, b) => a.temp - b.temp);
    }
    // Sort and collapse duplicate temperatures (last one wins) so the curve the
    // backend receives never has two points at the same temp (a zero-width segment).
    // Use this when persisting/applying a curve, not while editing.
    function normalizePoints(pts) {
        const byTemp = new Map();
        for (const p of sortPoints(pts))
            byTemp.set(p.temp, p);
        return Array.from(byTemp.values()).sort((a, b) => a.temp - b.temp);
    }
    // Read-only SVG plot of the curve with an optional live marker at the current
    // temperature (green dashed line).
    const CurveGraph = ({ points, maxRpm, tempC, }) => {
        const W = 300;
        const H = 130;
        const padL = 4, padR = 4, padT = 6, padB = 6;
        const x = (t) => padL + ((t - T_MIN) / (T_MAX - T_MIN)) * (W - padL - padR);
        const y = (r) => padT + (1 - r / Math.max(1, maxRpm)) * (H - padT - padB);
        const pts = sortPoints(points);
        const line = pts.map((p) => `${x(p.temp).toFixed(1)},${y(p.rpm).toFixed(1)}`).join(" ");
        const haveTemp = typeof tempC === "number";
        return (window.SP_REACT.createElement("svg", { width: "100%", viewBox: `0 0 ${W} ${H}`, style: { background: "rgba(255,255,255,0.04)", borderRadius: "6px" } },
            [0.25, 0.5, 0.75].map((g) => (window.SP_REACT.createElement("line", { key: g, x1: padL, x2: W - padR, y1: padT + g * (H - padT - padB), y2: padT + g * (H - padT - padB), stroke: "rgba(255,255,255,0.08)", strokeWidth: "1" }))),
            pts.length >= 2 ? (window.SP_REACT.createElement("polyline", { points: line, fill: "none", stroke: "#5b7cf0", strokeWidth: "2.5", strokeLinejoin: "round", strokeLinecap: "round" })) : null,
            pts.map((p, i) => (window.SP_REACT.createElement("circle", { key: i, cx: x(p.temp), cy: y(p.rpm), r: "3.5", fill: "#f1f4fa" }))),
            haveTemp ? (window.SP_REACT.createElement("line", { x1: x(tempC), x2: x(tempC), y1: padT, y2: H - padB, stroke: "#52d669", strokeWidth: "1.5", strokeDasharray: "3 3" })) : null));
    };
    // Controlled editor for a fan curve: graph + interpolate toggle + per-point
    // temperature/RPM sliders with add/remove. Used for the live active curve and
    // for each saved profile.
    const CurveEditor = ({ points, interpolate, maxRpm, tempC, busy, onPoints, onInterpolate }) => {
        function setPoint(i, key, val) {
            onPoints(points.map((p, j) => (j === i ? { ...p, [key]: val } : p)));
        }
        function removePoint(i) {
            onPoints(points.filter((_, j) => j !== i));
        }
        function addPoint() {
            const sorted = sortPoints(points);
            const last = sorted[sorted.length - 1];
            const temp = last ? Math.min(T_MAX, last.temp + 10) : 60;
            // Already at the max temperature — adding here would stack a duplicate temp
            // (a degenerate curve point). Bail instead; the add button is also disabled.
            if (last && temp <= last.temp)
                return;
            const rpm = last ? Math.min(maxRpm, last.rpm + 1000) : 3000;
            onPoints([...points, { temp, rpm }]);
        }
        const atMaxTemp = points.length > 0 && Math.max(...points.map((p) => p.temp)) >= T_MAX;
        return (window.SP_REACT.createElement("div", null,
            window.SP_REACT.createElement(CurveGraph, { points: points, maxRpm: maxRpm, tempC: tempC }),
            window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: "Smooth (interpolate between points)", checked: interpolate, onChange: onInterpolate }),
            window.SP_REACT.createElement("div", { style: { fontWeight: 600, margin: "8px 0 2px" } }, "Curve points"),
            points.length < 2 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6, margin: "4px 0" } }, "Add at least two points to define a curve.")) : null,
            points.map((p, i) => (window.SP_REACT.createElement("div", { key: i, style: {
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: "6px",
                    padding: "6px 10px",
                    marginBottom: "8px",
                    background: "rgba(255,255,255,0.03)",
                } },
                window.SP_REACT.createElement(Stepper, { label: "Temperature \u00B0C", value: p.temp, min: T_MIN, max: T_MAX, step: 1, coarse: 5, unit: "\u00B0C", disabled: busy, onChange: (v) => setPoint(i, "temp", v) }),
                window.SP_REACT.createElement(Stepper, { label: "Fan RPM", value: p.rpm, min: 0, max: maxRpm, step: 100, coarse: 1000, disabled: busy, onChange: (v) => setPoint(i, "rpm", v) }),
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { style: { marginTop: "4px" }, disabled: busy, onClick: () => removePoint(i) }, "Remove point")))),
            window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px", marginTop: "4px" } },
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy || atMaxTemp, onClick: addPoint }, "+ Add point"))));
    };

    // Sentinel for the top-level dropdown entry that groups the curated Docky tasks.
    const DOCKY_BUILTIN = "__docky_builtin__";
    function GearIcon() {
        return (window.SP_REACT.createElement("svg", { width: "1.2em", height: "1.2em", viewBox: "0 0 24 24", fill: "currentColor" },
            window.SP_REACT.createElement("path", { d: "M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.34.68.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.58-.24 1.12-.56 1.62-.94l2.39.96c.26.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" })));
    }
    // Popup window for a task type's global settings (e.g. the PCSX2 profiles path).
    // Keeps its own field state for display; each edit also calls onChange so the
    // parent editor's draft (config.taskSettings[type]) updates and marks dirty.
    const TaskSettingsModal = ({ closeModal, def, initial, onChange }) => {
        const [vals, setVals] = react.useState({ ...initial });
        return (window.SP_REACT.createElement(deckyFrontendLib.ModalRoot, { onCancel: closeModal, onEscKeypress: closeModal },
            window.SP_REACT.createElement("div", { style: { fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" } },
                def.label,
                " \u2014 settings"),
            (def.settings || []).map((s) => (window.SP_REACT.createElement("div", { key: s.key, style: { marginBottom: "10px" } },
                window.SP_REACT.createElement(TextRow, { label: s.label, value: vals[s.key] ?? "", onChange: (v) => {
                        setVals({ ...vals, [s.key]: v });
                        onChange(s.key, v);
                    } }),
                s.description ? (window.SP_REACT.createElement("div", { style: { fontSize: "0.75em", opacity: 0.6, marginTop: "2px" } }, s.description)) : null,
                s.default ? (window.SP_REACT.createElement("div", { style: { fontSize: "0.7em", opacity: 0.5, marginTop: "2px" } },
                    "Default: ",
                    s.default)) : null))),
            window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: () => closeModal?.() }, "Done")));
    };
    // Add-task form for one action: pick a type, fill its fields, append.
    // Curated Docky tasks (e.g. PCSX2 profile) live behind a "Docky built-in task"
    // entry with its own sub-dropdown; generic ops are listed directly.
    const AddTask = ({ profiles, profileOpts, busy, onAdd, taskSettings, onChangeTaskSetting, installedPlugins }) => {
        const pluginOk = (d) => !d.requiresPlugin || installedPlugins.indexOf(d.requiresPlugin) !== -1;
        const optLabel = (d) => pluginOk(d) ? d.label : d.label + ` (needs ${d.requiresPlugin})`;
        const hasBuiltins = BUILTIN_DEFS.length > 0;
        const [top, setTop] = react.useState(hasBuiltins ? DOCKY_BUILTIN : GENERIC_DEFS[0] ? GENERIC_DEFS[0].type : "");
        const [builtinType, setBuiltinType] = react.useState(BUILTIN_DEFS[0] ? BUILTIN_DEFS[0].type : "");
        const [vals, setVals] = react.useState({});
        const type = top === DOCKY_BUILTIN ? builtinType : top;
        const def = taskDef(type);
        const topOptions = (hasBuiltins ? [{ data: DOCKY_BUILTIN, label: "Docky built-in task" }] : []).concat(GENERIC_DEFS.map((d) => ({ data: d.type, label: optLabel(d) })));
        const setField = (k, val) => setVals({ ...vals, [k]: val });
        const add = () => {
            const task = { type, __key: nextTaskKey() };
            def.fields.forEach((f) => {
                const val = vals[f.key];
                if (f.kind === "bool") {
                    // Honor the field's default when the user never touched the toggle.
                    if (val ?? f.def)
                        task[f.key] = true;
                }
                else if (val !== undefined && val !== "") {
                    task[f.key] = val;
                }
                else if (f.kind === "select" && f.options && f.options.length) {
                    // Untouched dropdown: persist the shown default (its first option).
                    task[f.key] = f.options[0].data;
                }
                else if (f.kind === "fanProfile" && profileOpts.fan[0]) {
                    task[f.key] = profileOpts.fan[0].data;
                }
                else if (f.kind === "tdpProfile" && profileOpts.tdp[0]) {
                    task[f.key] = profileOpts.tdp[0].data;
                }
            });
            if (type === "pcsx2_profile" && !task.profile && profiles.length)
                task.profile = profiles[0];
            onAdd(task);
            setVals({});
        };
        const valid = pluginOk(def) && (type === "pcsx2_profile" ? profiles.length > 0 : true);
        const fieldEls = def.fields.map((f) => {
            if (f.kind === "bool") {
                return (window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { key: f.key, label: f.label, checked: vals[f.key] ?? !!f.def, onChange: (val) => setField(f.key, val) }));
            }
            if (f.kind === "profile") {
                if (!profiles.length) {
                    return (window.SP_REACT.createElement(deckyFrontendLib.Field, { key: f.key, label: f.label },
                        window.SP_REACT.createElement("span", { style: { opacity: 0.7 } }, "No PCSX2 profiles found")));
                }
                return (window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { key: f.key, label: f.label, rgOptions: profiles.map((p) => ({ data: p, label: p })), selectedOption: vals[f.key] || profiles[0], onChange: (o) => setField(f.key, o.data) }));
            }
            if (f.kind === "select" || f.kind === "fanProfile" || f.kind === "tdpProfile") {
                const opts = f.kind === "fanProfile" ? profileOpts.fan : f.kind === "tdpProfile" ? profileOpts.tdp : f.options || [];
                if (!opts.length) {
                    return (window.SP_REACT.createElement(deckyFrontendLib.Field, { key: f.key, label: f.label },
                        window.SP_REACT.createElement("span", { style: { opacity: 0.7 } }, "No profiles yet \u2014 make one in the Fan/TDP tab")));
                }
                return (window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { key: f.key, label: f.label, rgOptions: opts, selectedOption: vals[f.key] ?? (opts[0] ? opts[0].data : ""), onChange: (o) => setField(f.key, o.data) }));
            }
            return (window.SP_REACT.createElement(TextRow, { key: f.key, label: f.label, value: vals[f.key], onChange: (val) => setField(f.key, val) }));
        });
        const hasSettings = !!(def.settings && def.settings.length);
        const openSettings = () => deckyFrontendLib.showModal(window.SP_REACT.createElement(TaskSettingsModal, { def: def, initial: taskSettings[type] || {}, onChange: (k, v) => onChangeTaskSetting(type, k, v) }));
        // Gear next to the task-type dropdown; grayed unless this type has settings.
        const gear = (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy || !hasSettings, onClick: openSettings, style: { minWidth: 0, padding: "6px 10px", display: "flex", alignItems: "center", justifyContent: "center" } },
            window.SP_REACT.createElement(GearIcon, null)));
        return (window.SP_REACT.createElement("div", { style: { marginTop: "8px", borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "8px" } },
            window.SP_REACT.createElement("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "Add a task"),
            top === DOCKY_BUILTIN && BUILTIN_DEFS.length > 0 ? (window.SP_REACT.createElement(window.SP_REACT.Fragment, null,
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "Task type", rgOptions: topOptions, selectedOption: top, onChange: (o) => {
                        setTop(o.data);
                        setVals({});
                    } }),
                window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px", alignItems: "center" } },
                    window.SP_REACT.createElement("div", { style: { flex: 1 } },
                        window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "Built-in task", rgOptions: BUILTIN_DEFS.map((d) => ({ data: d.type, label: optLabel(d) })), selectedOption: builtinType, onChange: (o) => {
                                setBuiltinType(o.data);
                                setVals({});
                            } })),
                    gear))) : (window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px", alignItems: "center" } },
                window.SP_REACT.createElement("div", { style: { flex: 1 } },
                    window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "Task type", rgOptions: topOptions, selectedOption: top, onChange: (o) => {
                            setTop(o.data);
                            setVals({});
                        } })),
                gear)),
            !pluginOk(def) ? (window.SP_REACT.createElement("div", { style: { color: "#e8a33d", fontSize: "0.8em", margin: "4px 0" } },
                "Requires the \u201C",
                def.requiresPlugin,
                "\u201D plugin, which isn\u2019t installed.")) : (fieldEls),
            window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy || !valid, onClick: add }, "+ Add task")));
    };
    // One tab button in the top tab bar.
    const TabButton = ({ active, label, onClick, }) => (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: onClick, style: {
            flex: 1,
            minWidth: 0,
            padding: "6px 4px",
            fontWeight: active ? 700 : 400,
            background: active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.04)",
            borderBottom: active ? "2px solid #1a9fff" : "2px solid transparent",
            borderRadius: "4px 4px 0 0",
        } }, label));
    // A full-width row that drills into an item's detail when clicked.
    const ListRow = ({ label, sub, onClick }) => (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: onClick, style: {
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "6px",
            textAlign: "left",
        } },
        window.SP_REACT.createElement("span", { style: { fontWeight: 600 } }, label),
        window.SP_REACT.createElement("span", { style: { opacity: 0.6, fontSize: "0.85em" } }, sub ? sub + " ›" : "›")));
    // Render a single task field bound to `value`, calling onChange with the new
    // value. Used to edit a task already in an action (bool/select/profile/text).
    function renderTaskField(f, value, onChange, profiles, profileOpts) {
        if (f.kind === "bool") {
            return (window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { key: f.key, label: f.label, checked: !!value, onChange: (v) => onChange(v) }));
        }
        if (f.kind === "profile") {
            if (!profiles.length) {
                return (window.SP_REACT.createElement(deckyFrontendLib.Field, { key: f.key, label: f.label },
                    window.SP_REACT.createElement("span", { style: { opacity: 0.7 } }, "No PCSX2 profiles found")));
            }
            return (window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { key: f.key, label: f.label, rgOptions: profiles.map((p) => ({ data: p, label: p })), selectedOption: value || profiles[0], onChange: (o) => onChange(o.data) }));
        }
        if (f.kind === "select" || f.kind === "fanProfile" || f.kind === "tdpProfile") {
            const opts = f.kind === "fanProfile" ? profileOpts.fan : f.kind === "tdpProfile" ? profileOpts.tdp : f.options || [];
            if (!opts.length) {
                return (window.SP_REACT.createElement(deckyFrontendLib.Field, { key: f.key, label: f.label },
                    window.SP_REACT.createElement("span", { style: { opacity: 0.7 } }, "No profiles yet")));
            }
            return (window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { key: f.key, label: f.label, rgOptions: opts, selectedOption: value ?? (opts[0] ? opts[0].data : ""), onChange: (o) => onChange(o.data) }));
        }
        return window.SP_REACT.createElement(TextRow, { key: f.key, label: f.label, value: value ?? "", onChange: (v) => onChange(v) });
    }
    // Pick an action/mode (encoded "kind:id") not yet favorited, and add it.
    const AddFavorite = ({ options, busy, onAdd }) => {
        const [sel, setSel] = react.useState(options[0] ? options[0].data : "");
        // Keep the selection valid as the option list shrinks after each add.
        const cur = options.some((o) => o.data === sel) ? sel : options[0] ? options[0].data : "";
        return (window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px", alignItems: "center" } },
            window.SP_REACT.createElement("div", { style: { flex: 1 } },
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "Item", rgOptions: options, selectedOption: cur, onChange: (o) => setSel(o.data) })),
            window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy || !cur, onClick: () => cur && onAdd(cur) }, "+ Add")));
    };
    // Small fixed-width button for the favorite reorder/remove controls.
    const MiniButton = ({ disabled, width, onClick, children, }) => (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: disabled, onClick: onClick, style: { minWidth: 0, width, padding: "6px 4px", textAlign: "center" } }, children));
    // A label/value row in the Sunshine tab (module-scope so it isn't remounted on
    // every render of the editor).
    const InfoRow = ({ label, value }) => (window.SP_REACT.createElement("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0" } },
        window.SP_REACT.createElement("span", { style: { opacity: 0.7 } }, label),
        window.SP_REACT.createElement("span", { style: { fontWeight: 600 } }, value || "—")));
    const EditorModal = ({ closeModal, initialConfig, initialTab, profiles, installedPlugins, onSaved }) => {
        const [cfg, setCfg] = react.useState(() => withTaskKeys(clone(initialConfig)));
        const [dirty, setDirty] = react.useState(false);
        const [busy, setBusy] = react.useState(false);
        const [msg, setMsg] = react.useState("");
        const [tab, setTab] = react.useState(initialTab || "actions");
        const [selAction, setSelAction] = react.useState(null);
        const [selMode, setSelMode] = react.useState(null);
        const [selFan, setSelFan] = react.useState(null);
        const [selTdp, setSelTdp] = react.useState(null);
        // Sunshine tab (live actions, not part of the config draft).
        const [sunInfo, setSunInfo] = react.useState(null);
        const [sunBusy, setSunBusy] = react.useState(false);
        const [sunMsg, setSunMsg] = react.useState("");
        function refreshSunshine() {
            setSunBusy(true);
            setSunMsg("Checking flathub…");
            call("sunshine_version_info")
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
        function doSunshine(method, verb) {
            setSunBusy(true);
            setSunMsg(verb + " Sunshine… (this can take a minute)");
            call(method)
                .then((r) => {
                setSunBusy(false);
                if (r && r.info)
                    setSunInfo(r.info);
                if (r && r.state)
                    onSaved(r.state);
                setSunMsg(r && r.message ? r.message : verb + " done");
            })
                .catch((err) => {
                setSunBusy(false);
                setSunMsg("Error: " + errText(err));
            });
        }
        // Check versions the first time the Sunshine tab is opened.
        react.useEffect(() => {
            if (tab === "sunshine" && !sunInfo && !sunBusy)
                refreshSunshine();
        }, [tab]);
        function mutate(fn) {
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
            call("save_config", { config: stripTaskKeys(cfg) })
                .then((r) => {
                setBusy(false);
                if (r && r.ok) {
                    setDirty(false);
                    setMsg("Saved");
                    toast("Configuration saved");
                    if (r.state)
                        onSaved(r.state);
                }
                else {
                    setMsg("Save failed: " + ((r && r.error) || "unknown error"));
                    toast("Save failed");
                }
            })
                .catch((err) => {
                setBusy(false);
                setMsg("Error: " + errText(err));
            });
        }
        const cfgActions = cfg.actions || {};
        const cfgModes = cfg.modes || {};
        const cfgFanProfiles = cfg.fanProfiles || {};
        const cfgTdpProfiles = cfg.tdpProfiles || {};
        const actionIds = Object.keys(cfgActions);
        const modeIds = Object.keys(cfgModes);
        const modeOpts = [{ data: "", label: "(none)" }].concat(modeIds.map((mid) => ({ data: mid, label: cfgModes[mid].name || mid })));
        // Options for the saved-profile task fields. Fan adds an explicit "auto".
        const profileOpts = {
            fan: [{ data: "auto", label: "Auto (SteamOS)" }].concat(Object.keys(cfgFanProfiles).map((id) => ({ data: id, label: cfgFanProfiles[id].name || id }))),
            tdp: Object.keys(cfgTdpProfiles).map((id) => ({ data: id, label: cfgTdpProfiles[id].name || id })),
        };
        const fanMax = 8000;
        const tdpMax = 30;
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
                return (window.SP_REACT.createElement("div", null,
                    window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: () => setSelAction(null), style: { marginBottom: "8px" } }, "\u2039 All actions"),
                    window.SP_REACT.createElement(Card, { title: action.name || aid },
                        window.SP_REACT.createElement(TextRow, { label: "Name", value: action.name, onChange: (val) => mutate((n) => { n.actions[aid].name = val; }) }),
                        window.SP_REACT.createElement("div", { style: { fontWeight: 600, margin: "6px 0 2px" } }, "Tasks"),
                        (action.tasks || []).length === 0 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6, margin: "4px 0" } }, "No tasks yet")) : ((action.tasks || []).map((task, ti) => {
                            const d = taskDef(task.type);
                            const fields = d ? d.fields : [];
                            const setField = (f, value) => mutate((n) => {
                                const t = n.actions[aid].tasks[ti];
                                if (f.kind === "bool") {
                                    if (value)
                                        t[f.key] = true;
                                    else
                                        delete t[f.key];
                                }
                                else if (value === "" || value === undefined) {
                                    delete t[f.key];
                                }
                                else {
                                    t[f.key] = value;
                                }
                            });
                            return (window.SP_REACT.createElement(Card, { key: task.__key || ti, title: d ? d.label : task.type },
                                window.SP_REACT.createElement("div", { style: { fontSize: "0.78em", opacity: 0.6, marginBottom: "4px" } }, summarizeTask(task)),
                                fields.map((f) => renderTaskField(f, task[f.key], (v) => setField(f, v), profiles, profileOpts)),
                                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { style: { marginTop: "6px" }, disabled: busy, onClick: () => mutate((n) => { n.actions[aid].tasks.splice(ti, 1); }) }, "Remove task")));
                        })),
                        window.SP_REACT.createElement(AddTask, { profiles: profiles, profileOpts: profileOpts, busy: busy, onAdd: (task) => mutate((n) => {
                                n.actions[aid].tasks = n.actions[aid].tasks || [];
                                n.actions[aid].tasks.push(task);
                            }), taskSettings: cfg.taskSettings || {}, onChangeTaskSetting: (type, key, value) => mutate((n) => {
                                n.taskSettings = n.taskSettings || {};
                                n.taskSettings[type] = n.taskSettings[type] || {};
                                n.taskSettings[type][key] = value;
                            }), installedPlugins: installedPlugins }),
                        window.SP_REACT.createElement("div", { style: { marginTop: "10px" } },
                            window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => {
                                    mutate((n) => {
                                        delete n.actions[aid];
                                        Object.keys(n.modes).forEach((mid) => {
                                            n.modes[mid].actions = (n.modes[mid].actions || []).filter((x) => x !== aid);
                                        });
                                    });
                                    setSelAction(null);
                                } }, "Delete action")))));
            }
            return (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: newAction, disabled: busy, style: { marginBottom: "10px" } }, "+ New action"),
                actionIds.length === 0 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6 } }, "No actions yet. Use \u201C+ New action\u201D to create one.")) : (actionIds.map((aid) => {
                    const a = cfgActions[aid];
                    const n = (a.tasks || []).length;
                    return (window.SP_REACT.createElement(ListRow, { key: aid, label: a.name || aid, sub: n + " task" + (n === 1 ? "" : "s"), onClick: () => setSelAction(aid) }));
                }))));
        }
        // ---- MODES TAB ----
        function renderModes() {
            if (selMode && cfgModes[selMode]) {
                const mid = selMode;
                const mode = cfgModes[mid];
                const inMode = mode.actions || [];
                return (window.SP_REACT.createElement("div", null,
                    window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: () => setSelMode(null), style: { marginBottom: "8px" } }, "\u2039 All modes"),
                    window.SP_REACT.createElement(Card, { title: mode.name || mid },
                        window.SP_REACT.createElement(TextRow, { label: "Name", value: mode.name, onChange: (val) => mutate((n) => { n.modes[mid].name = val; }) }),
                        window.SP_REACT.createElement("div", { style: { fontWeight: 600, margin: "6px 0 2px" } }, "Actions run in this mode"),
                        actionIds.length === 0 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6 } }, "No actions to assign. Create some in the Actions tab.")) : (actionIds.map((aid) => (window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { key: aid, label: cfgActions[aid].name || aid, checked: inMode.indexOf(aid) !== -1, disabled: busy, onChange: (on) => mutate((n) => {
                                const arr = (n.modes[mid].actions = n.modes[mid].actions || []);
                                const idx = arr.indexOf(aid);
                                if (on && idx === -1)
                                    arr.push(aid);
                                if (!on && idx !== -1)
                                    arr.splice(idx, 1);
                            }) })))),
                        window.SP_REACT.createElement("div", { style: { marginTop: "10px" } },
                            window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => {
                                    mutate((n) => {
                                        delete n.modes[mid];
                                        if (n.settings.dockedMode === mid)
                                            n.settings.dockedMode = "";
                                        if (n.settings.undockedMode === mid)
                                            n.settings.undockedMode = "";
                                    });
                                    setSelMode(null);
                                } }, "Delete mode")))));
            }
            return (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: newMode, disabled: busy, style: { marginBottom: "10px" } }, "+ New mode"),
                modeIds.length === 0 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6 } }, "No modes yet. Use \u201C+ New mode\u201D to create one.")) : (modeIds.map((mid) => (window.SP_REACT.createElement(ListRow, { key: mid, label: cfgModes[mid].name || mid, onClick: () => setSelMode(mid) }))))));
        }
        // ---- FAVORITES TAB ----
        function renderFavorites() {
            const favs = cfg.favorites || [];
            const key = (f) => f.kind + ":" + f.id;
            const have = {};
            favs.forEach((f) => (have[key(f)] = true));
            const options = actionIds
                .filter((id) => !have["action:" + id])
                .map((id) => ({ data: "action:" + id, label: "Action — " + (cfgActions[id].name || id) }))
                .concat(modeIds
                .filter((id) => !have["mode:" + id])
                .map((id) => ({ data: "mode:" + id, label: "Mode — " + (cfgModes[id].name || id) })));
            function swap(i, j) {
                mutate((n) => {
                    const a = n.favorites;
                    const t = a[i];
                    a[i] = a[j];
                    a[j] = t;
                });
            }
            return (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement("div", { style: { fontWeight: 700, margin: "2px 0 6px" } }, "Favorites"),
                window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.6, marginBottom: "8px" } }, "Pinned actions and modes appear in the panel\u2019s Favorites section, in this order. Use \u25B2\u25BC to sort."),
                favs.length === 0 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6, marginBottom: "8px" } }, "No favorites yet.")) : (favs.map((f, i) => {
                    const item = f.kind === "action" ? cfgActions[f.id] : cfgModes[f.id];
                    const name = item ? item.name || f.id : f.id;
                    const tag = f.kind === "action" ? "Action" : "Mode";
                    return (window.SP_REACT.createElement(deckyFrontendLib.Field, { key: key(f), label: tag + ": " + name + (item ? "" : " (missing)"), bottomSeparator: "none" },
                        window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "4px" } },
                            window.SP_REACT.createElement(MiniButton, { width: "3em", disabled: busy || i === 0, onClick: () => swap(i, i - 1) }, "\u25B2"),
                            window.SP_REACT.createElement(MiniButton, { width: "3em", disabled: busy || i === favs.length - 1, onClick: () => swap(i, i + 1) }, "\u25BC"),
                            window.SP_REACT.createElement(MiniButton, { width: "5.5em", disabled: busy, onClick: () => mutate((n) => { n.favorites.splice(i, 1); }) }, "Remove"))));
                })),
                window.SP_REACT.createElement("div", { style: { fontWeight: 600, margin: "12px 0 2px" } }, "Add a favorite"),
                options.length === 0 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6 } }, actionIds.length + modeIds.length === 0
                    ? "Create actions or modes first."
                    : "Everything is already favorited.")) : (window.SP_REACT.createElement(AddFavorite, { options: options, busy: busy, onAdd: (value) => mutate((n) => {
                        const idx = value.indexOf(":");
                        const kind = value.slice(0, idx);
                        const id = value.slice(idx + 1);
                        n.favorites = n.favorites || [];
                        n.favorites.push({ kind, id });
                    }) }))));
        }
        // ---- SUNSHINE TAB ----
        function renderSunshine() {
            const info = sunInfo;
            const engine = cfg.settings.sunshineEngine || "auto";
            const deckyInstalled = (info && info.deckySunshineInstalled) ||
                installedPlugins.indexOf("decky-sunshine") !== -1;
            // What's actually in effect (server-resolved when on auto).
            const resolved = info && info.resolvedEngine
                ? info.resolvedEngine
                : engine !== "auto"
                    ? engine
                    : deckyInstalled ? "decky-sunshine" : info && info.installed ? "integrated" : "off";
            const integrated = resolved === "integrated";
            const isDecky = resolved === "decky-sunshine";
            const isOff = resolved === "off";
            const blurb = isDecky
                ? "Using the decky-sunshine plugin for install/launch/update. Docky's other Sunshine tasks (stop, encoder, composition, pairing) still work on the shared Sunshine."
                : isOff
                    ? "Sunshine isn't set up yet. Install & enable it below to let Docky manage it, or install the decky-sunshine plugin and Docky will use that automatically."
                    : "Docky owns Sunshine: installs it from Flathub, launches it, and keeps it updated.";
            return (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement("div", { style: { fontWeight: 700, margin: "2px 0 6px" } }, "Sunshine"),
                window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.6, marginBottom: "10px" } }, blurb),
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "Sunshine engine", rgOptions: [
                        { data: "auto", label: "Auto" + (engine === "auto" ? " → " + resolved : "") },
                        { data: "integrated", label: "Integrated (Docky)" },
                        {
                            data: "decky-sunshine",
                            label: "decky-sunshine" + (deckyInstalled ? "" : " (not installed)"),
                        },
                        { data: "off", label: "Off" },
                    ], selectedOption: engine, onChange: (o) => mutate((n) => { n.settings.sunshineEngine = o.data; }) }),
                engine === "decky-sunshine" && !deckyInstalled ? (window.SP_REACT.createElement("div", { style: { color: "#e8a33d", fontSize: "0.8em", margin: "4px 0" } }, "decky-sunshine isn\u2019t installed \u2014 install it from the Decky store, or use Auto / Integrated.")) : null,
                engine === "integrated" && deckyInstalled ? (window.SP_REACT.createElement("div", { style: { color: "#e8a33d", fontSize: "0.8em", margin: "4px 0" } }, "decky-sunshine is also installed. With Integrated, both may try to launch Sunshine and fight over the streaming port. Use Auto (recommended), or disable decky-sunshine\u2019s autostart.")) : null,
                !info ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6 } }, sunBusy ? "Checking…" : "—")) : (window.SP_REACT.createElement(window.SP_REACT.Fragment, null,
                    window.SP_REACT.createElement(InfoRow, { label: "Status", value: info.installed ? "Installed" : "Not installed" }),
                    window.SP_REACT.createElement(InfoRow, { label: "Current version", value: info.installedVersion }),
                    window.SP_REACT.createElement(InfoRow, { label: "Latest version", value: info.latestVersion }),
                    info.installed ? (window.SP_REACT.createElement("div", { style: {
                            fontSize: "0.85em",
                            margin: "4px 0",
                            color: info.updateAvailable ? "#e8a33d" : undefined,
                            opacity: info.updateAvailable ? 1 : 0.6,
                        } }, info.updateAvailable ? "Update available" : "Up to date")) : null)),
                window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px", marginTop: "10px" } },
                    isDecky ? null : info && !info.installed ? (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: sunBusy, onClick: () => doSunshine("sunshine_install", "Installing") }, "Install & enable Sunshine")) : (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: sunBusy || !(info && info.updateAvailable), onClick: () => doSunshine("sunshine_update", "Updating") }, "Update Sunshine")),
                    window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: sunBusy, onClick: refreshSunshine }, "Refresh")),
                isDecky ? (window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.6, marginTop: "6px" } }, "Install & updates are managed in decky-sunshine.")) : null,
                sunMsg ? (window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.8, marginTop: "10px" } }, sunMsg)) : null,
                window.SP_REACT.createElement("div", { style: { fontWeight: 700, margin: "14px 0 2px" } }, "Behavior"),
                window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: "Start Sunshine at boot", description: integrated
                        ? "Launch Sunshine when Docky loads after a reboot"
                        : "Managed by decky-sunshine in this mode", checked: integrated && cfg.settings.autostartSunshine !== false, disabled: busy || !integrated, onChange: (on) => mutate((n) => { n.settings.autostartSunshine = on; }) })));
        }
        // ---- AUTO-DOCK TAB ----
        function renderAutoDock() {
            const strict = cfg.settings.requireExternalDisplay !== false; // default true
            return (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement("div", { style: { fontWeight: 700, margin: "2px 0 2px" } }, "Dock"),
                window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.6, marginBottom: "6px" } }, "How a dock is detected, and which mode to switch to on dock / undock."),
                window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: "Require an external display", description: "Docked only when a monitor is actually connected. Uncheck to detect a dock that has no display attached.", checked: strict, onChange: (on) => mutate((n) => { n.settings.requireExternalDisplay = on; }) }),
                window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: "Require AC power", description: "Count external power as docked. Note: a plain wall charger counts too.", checked: !!cfg.settings.requireAcPower, disabled: strict, onChange: (on) => mutate((n) => { n.settings.requireAcPower = on; }) }),
                window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: "Require a USB hub (dock)", description: "Count an attached USB hub / dock as docked. Enable both to mean a real dock (AC + hub).", checked: !!cfg.settings.requireUsbHub, disabled: strict, onChange: (on) => mutate((n) => { n.settings.requireUsbHub = on; }) }),
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "When docked \u2192 mode", rgOptions: modeOpts, selectedOption: cfg.settings.dockedMode || "", onChange: (o) => mutate((n) => { n.settings.dockedMode = o.data; }) }),
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "When undocked \u2192 mode", rgOptions: modeOpts, selectedOption: cfg.settings.undockedMode || "", onChange: (o) => mutate((n) => { n.settings.undockedMode = o.data; }) }),
                window.SP_REACT.createElement("div", { style: { fontWeight: 700, margin: "14px 0 2px" } }, "AC power"),
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "When AC connects \u2192 mode", rgOptions: modeOpts, selectedOption: cfg.settings.acMode || "", onChange: (o) => mutate((n) => { n.settings.acMode = o.data; }) }),
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "When on battery \u2192 mode", rgOptions: modeOpts, selectedOption: cfg.settings.noAcMode || "", onChange: (o) => mutate((n) => { n.settings.noAcMode = o.data; }) }),
                window.SP_REACT.createElement("div", { style: { fontWeight: 700, margin: "14px 0 2px" } }, "External controller"),
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "When a controller connects \u2192 mode", rgOptions: modeOpts, selectedOption: cfg.settings.controllerConnectMode || "", onChange: (o) => mutate((n) => { n.settings.controllerConnectMode = o.data; }) }),
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "When it disconnects \u2192 mode", rgOptions: modeOpts, selectedOption: cfg.settings.controllerDisconnectMode || "", onChange: (o) => mutate((n) => { n.settings.controllerDisconnectMode = o.data; }) }),
                window.SP_REACT.createElement("div", { style: { fontWeight: 700, margin: "14px 0 2px" } }, "Resume & startup"),
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "On wake from sleep \u2192 mode", rgOptions: modeOpts, selectedOption: cfg.settings.resumeMode || "", onChange: (o) => mutate((n) => { n.settings.resumeMode = o.data; }) }),
                window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "On startup (boot) \u2192 mode", rgOptions: modeOpts, selectedOption: cfg.settings.startupMode || "", onChange: (o) => mutate((n) => { n.settings.startupMode = o.data; }) }),
                window.SP_REACT.createElement(TextRow, { label: "Poll interval (seconds)", value: String(cfg.settings.pollSeconds || 3), onChange: (val) => mutate((n) => {
                        const num = parseInt(val, 10);
                        n.settings.pollSeconds = isNaN(num) || num < 1 ? 1 : num;
                    }) }),
                window.SP_REACT.createElement("div", { style: { fontSize: "0.7em", opacity: 0.6, marginTop: "6px" } }, "Enable each trigger from the panel's Triggers section; map it to a mode here.")));
        }
        // ---- FAN TAB (build/manage fan profiles) ----
        function newFanProfile() {
            const next = clone(cfg);
            next.fanProfiles = next.fanProfiles || {};
            const id = uniqueId(slugify("New fan profile"), next.fanProfiles);
            next.fanProfiles[id] = {
                name: "New fan profile",
                mode: "curve",
                manualRpm: 3000,
                curve: {
                    interpolate: true,
                    points: [
                        { temp: 45, rpm: 0 },
                        { temp: 55, rpm: 1800 },
                        { temp: 65, rpm: 3200 },
                        { temp: 75, rpm: 4800 },
                        { temp: 85, rpm: 6500 },
                    ],
                },
            };
            setCfg(next);
            setDirty(true);
            setSelFan(id);
        }
        function renderFan() {
            if (selFan && cfgFanProfiles[selFan]) {
                const id = selFan;
                const prof = cfgFanProfiles[id];
                const mode = prof.mode || "curve";
                const curve = prof.curve || { interpolate: true, points: [] };
                return (window.SP_REACT.createElement("div", null,
                    window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: () => setSelFan(null), style: { marginBottom: "8px" } }, "\u2039 All fan profiles"),
                    window.SP_REACT.createElement(Card, { title: prof.name || id },
                        window.SP_REACT.createElement(TextRow, { label: "Name", value: prof.name, onChange: (v) => mutate((n) => { n.fanProfiles[id].name = v; }) }),
                        window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "Mode", rgOptions: [
                                { data: "curve", label: "Curve (temperature → RPM)" },
                                { data: "manual", label: "Manual (fixed RPM)" },
                                { data: "auto", label: "Auto (SteamOS)" },
                            ], selectedOption: mode, onChange: (o) => mutate((n) => { n.fanProfiles[id].mode = o.data; }) }),
                        mode === "manual" ? (window.SP_REACT.createElement(Stepper, { label: "Fan RPM", value: prof.manualRpm ?? 3000, min: 0, max: fanMax, step: 100, coarse: 1000, disabled: busy, onChange: (v) => mutate((n) => { n.fanProfiles[id].manualRpm = v; }) })) : null,
                        mode === "curve" ? (window.SP_REACT.createElement(CurveEditor, { points: (curve.points || []).map((p) => ({ temp: p.temp, rpm: p.rpm })), interpolate: curve.interpolate !== false, maxRpm: fanMax, busy: busy, onPoints: (p) => mutate((n) => { const c = n.fanProfiles[id].curve || {}; n.fanProfiles[id].curve = { interpolate: c.interpolate !== false, points: sortPoints(p) }; }), onInterpolate: (b) => mutate((n) => { const c = n.fanProfiles[id].curve || { points: [] }; n.fanProfiles[id].curve = { interpolate: b, points: c.points || [] }; }) })) : null,
                        mode === "auto" ? (window.SP_REACT.createElement("div", { style: { opacity: 0.7, fontSize: "0.85em", margin: "4px 0" } }, "Applying this profile hands the fan back to SteamOS.")) : null,
                        window.SP_REACT.createElement("div", { style: { marginTop: "10px" } },
                            window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => { mutate((n) => { delete n.fanProfiles[id]; }); setSelFan(null); } }, "Delete profile")))));
            }
            const ids = Object.keys(cfgFanProfiles);
            return (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: newFanProfile, disabled: busy, style: { marginBottom: "10px" } }, "+ New fan profile"),
                ids.length === 0 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6 } }, "No fan profiles yet. Create curves/manual presets here, then apply them from the panel, a task, or a mode.")) : (ids.map((id) => (window.SP_REACT.createElement(ListRow, { key: id, label: cfgFanProfiles[id].name || id, sub: cfgFanProfiles[id].mode || "curve", onClick: () => setSelFan(id) }))))));
        }
        // ---- TDP TAB (build/manage TDP profiles) ----
        function newTdpProfile() {
            const next = clone(cfg);
            next.tdpProfiles = next.tdpProfiles || {};
            const id = uniqueId(slugify("New TDP profile"), next.tdpProfiles);
            next.tdpProfiles[id] = { name: "New TDP profile", watts: 15 };
            setCfg(next);
            setDirty(true);
            setSelTdp(id);
        }
        function renderTdp() {
            if (selTdp && cfgTdpProfiles[selTdp]) {
                const id = selTdp;
                const prof = cfgTdpProfiles[id];
                return (window.SP_REACT.createElement("div", null,
                    window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: () => setSelTdp(null), style: { marginBottom: "8px" } }, "\u2039 All TDP profiles"),
                    window.SP_REACT.createElement(Card, { title: prof.name || id },
                        window.SP_REACT.createElement(TextRow, { label: "Name", value: prof.name, onChange: (v) => mutate((n) => { n.tdpProfiles[id].name = v; }) }),
                        window.SP_REACT.createElement(Stepper, { label: "TDP (watts)", value: prof.watts ?? 15, min: 3, max: tdpMax, step: 1, unit: "W", disabled: busy, onChange: (v) => mutate((n) => { n.tdpProfiles[id].watts = v; }) }),
                        window.SP_REACT.createElement("div", { style: { fontSize: "0.7em", opacity: 0.6, margin: "2px 0 8px" } },
                            "The slider goes to ",
                            tdpMax,
                            "W; an unlocked BIOS is required to exceed the stock 15W cap."),
                        window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => { mutate((n) => { delete n.tdpProfiles[id]; }); setSelTdp(null); } }, "Delete profile"))));
            }
            const ids = Object.keys(cfgTdpProfiles);
            return (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: newTdpProfile, disabled: busy, style: { marginBottom: "10px" } }, "+ New TDP profile"),
                ids.length === 0 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6 } }, "No TDP profiles yet. Create wattage presets here, then apply them from the panel, a task, or a mode.")) : (ids.map((id) => (window.SP_REACT.createElement(ListRow, { key: id, label: cfgTdpProfiles[id].name || id, sub: (cfgTdpProfiles[id].watts ?? "?") + "W", onClick: () => setSelTdp(id) }))))));
        }
        return (window.SP_REACT.createElement(deckyFrontendLib.ModalRoot, { onCancel: closeModal, onEscKeypress: closeModal },
            window.SP_REACT.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" } },
                window.SP_REACT.createElement("div", { style: { fontSize: "1.4em", fontWeight: 700 } }, "Edit configuration"),
                window.SP_REACT.createElement("span", { style: { fontSize: "0.8em", opacity: 0.7 } }, dirty ? "Unsaved changes" : "Saved")),
            window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px", marginBottom: "10px" } },
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy || !dirty, onClick: saveCfg }, "Save"),
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => closeModal?.() }, dirty ? "Cancel" : "Close")),
            msg ? window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.8, marginBottom: "8px" } }, msg) : null,
            window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "4px", marginBottom: "10px" } },
                window.SP_REACT.createElement(TabButton, { active: tab === "actions", label: "Actions", onClick: () => setTab("actions") }),
                window.SP_REACT.createElement(TabButton, { active: tab === "modes", label: "Modes", onClick: () => setTab("modes") }),
                window.SP_REACT.createElement(TabButton, { active: tab === "favorites", label: "Favorites", onClick: () => setTab("favorites") }),
                window.SP_REACT.createElement(TabButton, { active: tab === "fan", label: "Fan", onClick: () => setTab("fan") }),
                window.SP_REACT.createElement(TabButton, { active: tab === "tdp", label: "TDP", onClick: () => setTab("tdp") }),
                window.SP_REACT.createElement(TabButton, { active: tab === "sunshine", label: "Sunshine", onClick: () => setTab("sunshine") }),
                window.SP_REACT.createElement(TabButton, { active: tab === "triggers", label: "Triggers", onClick: () => setTab("triggers") })),
            window.SP_REACT.createElement("div", { style: { maxHeight: "62vh", overflowY: "scroll", paddingRight: "6px" } },
                tab === "actions" ? renderActions() : null,
                tab === "modes" ? renderModes() : null,
                tab === "favorites" ? renderFavorites() : null,
                tab === "fan" ? renderFan() : null,
                tab === "tdp" ? renderTdp() : null,
                tab === "sunshine" ? renderSunshine() : null,
                tab === "triggers" ? renderAutoDock() : null)));
    };

    // Live editor for the *active* fan config, with quick apply of saved profiles
    // and a "save current as profile" shortcut. Full profile management lives in the
    // editor's Fan tab.
    const FanModal = ({ closeModal, onSaved }) => {
        const [cfg, setCfg] = react.useState(null);
        const [mode, setMode] = react.useState("auto");
        const [manualRpm, setManualRpm] = react.useState(3000);
        const [interpolate, setInterpolate] = react.useState(true);
        const [points, setPoints] = react.useState([]);
        const [maxRpm, setMaxRpm] = react.useState(8000);
        const [live, setLive] = react.useState(null);
        const [profiles, setProfiles] = react.useState([]);
        const [newName, setNewName] = react.useState("");
        const [busy, setBusy] = react.useState(false);
        const [msg, setMsg] = react.useState("");
        const [dirty, setDirty] = react.useState(false);
        // Mirror `busy` so the live poll can skip while a save/apply is in flight.
        const busyRef = react.useRef(false);
        react.useEffect(() => { busyRef.current = busy; }, [busy]);
        function loadFrom(c) {
            const s = c.settings || {};
            setCfg(c);
            setMode(s.fanMode || "auto");
            setManualRpm(typeof s.fanManualRpm === "number" ? s.fanManualRpm : 3000);
            setInterpolate(s.fanCurve?.interpolate !== false);
            setPoints((s.fanCurve?.points || []).map((p) => ({ temp: p.temp, rpm: p.rpm })));
            setProfiles(Object.keys(c.fanProfiles || {}).map((id) => ({ id, name: c.fanProfiles[id].name || id })));
        }
        react.useEffect(() => {
            call("get_config", {})
                .then((r) => loadFrom(r && r.config ? r.config : { actions: {}, modes: {}, settings: {} }))
                .catch((err) => setMsg("Error: " + errText(err)));
        }, []);
        react.useEffect(() => {
            let stop = false;
            function tick() {
                if (busyRef.current)
                    return; // don't poll over an in-flight save/apply
                call("get_state", {})
                    .then((st) => {
                    if (stop || !st || !st.fan)
                        return;
                    setLive(st.fan);
                    if (st.fan.maxRpm)
                        setMaxRpm(st.fan.maxRpm);
                })
                    .catch(() => { });
            }
            tick();
            const iv = setInterval(tick, 1500);
            return () => { stop = true; clearInterval(iv); };
        }, []);
        // Persist active fan settings into the whole config, then apply immediately.
        function save(applyMode, applyRpm) {
            if (!cfg)
                return;
            setBusy(true);
            setMsg("Saving…");
            const next = clone(cfg);
            next.settings = next.settings || {};
            next.settings.fanMode = applyMode;
            next.settings.fanManualRpm = applyRpm;
            next.settings.fanCurve = { interpolate, points: normalizePoints(points) };
            next.settings.fanProfile = ""; // manual edit, not a saved profile
            call("save_config", { config: next })
                .then((r) => {
                if (!(r && r.ok))
                    throw new Error((r && r.error) || "save failed");
                setCfg(next);
                setDirty(false);
                return call("set_fan_mode", { mode: applyMode, rpm: applyRpm });
            })
                .then((r) => {
                setBusy(false);
                setMsg(r && r.message ? r.message : "Applied");
                toast("Fan: " + (r && r.message ? r.message : applyMode));
                if (r && r.state)
                    onSaved(r.state);
            })
                .catch((err) => { setBusy(false); setMsg("Error: " + errText(err)); toast("Fan save failed"); });
        }
        function pickMode(m) {
            setMode(m);
            save(m, manualRpm);
        }
        // Apply a saved profile (loads it into the active config) and refresh the draft.
        function applyProfile(id) {
            setBusy(true);
            setMsg("Applying profile…");
            call("apply_fan_profile", { profile_id: id })
                .then((r) => {
                setBusy(false);
                setMsg(r && r.message ? r.message : "Applied");
                if (r && r.state)
                    onSaved(r.state);
                return call("get_config", {});
            })
                .then((r) => { if (r && r.config)
                loadFrom(r.config); })
                .catch((err) => { setBusy(false); setMsg("Error: " + errText(err)); });
        }
        // Save the current active settings as a new named profile.
        function saveAsProfile() {
            if (!cfg)
                return;
            const name = newName.trim();
            if (!name) {
                setMsg("Enter a profile name first");
                return;
            }
            setBusy(true);
            setMsg("Saving profile…");
            const next = clone(cfg);
            next.fanProfiles = next.fanProfiles || {};
            const id = uniqueId(slugify(name), next.fanProfiles);
            next.fanProfiles[id] = {
                name,
                mode,
                manualRpm,
                curve: { interpolate, points: normalizePoints(points) },
            };
            call("save_config", { config: next })
                .then((r) => {
                setBusy(false);
                if (!(r && r.ok))
                    throw new Error((r && r.error) || "save failed");
                loadFrom(next);
                setNewName("");
                setMsg("Saved profile '" + name + "'");
                toast("Saved fan profile");
                if (r.state)
                    onSaved(r.state);
            })
                .catch((err) => { setBusy(false); setMsg("Error: " + errText(err)); });
        }
        // Plain render helper (not an inline component) so the buttons keep a stable
        // element type across renders and don't remount / drop gamepad focus.
        const modeButton = (m, label) => (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => pickMode(m), style: {
                flex: 1, minWidth: 0, padding: "8px 4px",
                fontWeight: mode === m ? 700 : 400,
                background: mode === m ? "rgba(91,124,240,0.35)" : "rgba(255,255,255,0.06)",
                border: mode === m ? "1px solid #5b7cf0" : "1px solid transparent",
            } }, label));
        const unavailable = live && live.available === false;
        // A usable curve needs at least two points at distinct temperatures.
        const curveOk = normalizePoints(points).length >= 2;
        const profileOpts = [{ data: "", label: profiles.length ? "Apply a profile…" : "(no profiles yet)" }]
            .concat(profiles.map((p) => ({ data: p.id, label: p.name })));
        return (window.SP_REACT.createElement(deckyFrontendLib.ModalRoot, { onCancel: closeModal, onEscKeypress: closeModal },
            window.SP_REACT.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" } },
                window.SP_REACT.createElement("div", { style: { fontSize: "1.4em", fontWeight: 700 } }, "Fan control"),
                window.SP_REACT.createElement("div", { style: { fontSize: "0.95em", opacity: 0.9 } },
                    typeof live?.tempC === "number" ? `${live.tempC}°C` : "—°C",
                    " \u00B7",
                    " ",
                    typeof live?.rpm === "number" ? `${live.rpm} RPM` : "— RPM",
                    typeof live?.target === "number" && live.mode !== "auto" ? ` (→${live.target})` : "")),
            unavailable ? (window.SP_REACT.createElement("div", { style: { color: "#e8a33d", fontSize: "0.85em", marginBottom: "8px" } }, "No controllable fan found on this device.")) : null,
            profiles.length ? (window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "Saved profiles", rgOptions: profileOpts, selectedOption: "", onChange: (o) => o.data && applyProfile(o.data) })) : null,
            window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "6px", margin: "8px 0 10px" } },
                modeButton("auto", "Auto"),
                modeButton("curve", "Curve"),
                modeButton("manual", "Manual")),
            mode === "manual" ? (window.SP_REACT.createElement("div", { style: { marginBottom: "10px" } },
                window.SP_REACT.createElement(Stepper, { label: "Manual fan speed", value: manualRpm, min: 0, max: maxRpm, step: 100, coarse: 1000, disabled: busy, onChange: (v) => { setManualRpm(v); setDirty(true); } }),
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => save("manual", manualRpm) },
                    "Apply ",
                    manualRpm,
                    " RPM"))) : null,
            mode === "curve" ? (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement(CurveEditor, { points: points, interpolate: interpolate, maxRpm: maxRpm, tempC: live?.tempC, busy: busy, onPoints: (p) => { setPoints(p); setDirty(true); }, onInterpolate: (b) => { setInterpolate(b); setDirty(true); } }),
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy || !dirty || !curveOk, onClick: () => save("curve", manualRpm), style: { marginTop: "6px" } }, "Save & apply curve"))) : null,
            mode === "auto" ? (window.SP_REACT.createElement("div", { style: { opacity: 0.7, fontSize: "0.85em", margin: "4px 0 10px" } }, "SteamOS controls the fan. Pick Curve or Manual to take over.")) : null,
            mode !== "auto" ? (window.SP_REACT.createElement("div", { style: { borderTop: "1px solid rgba(255,255,255,0.1)", marginTop: "8px", paddingTop: "8px" } },
                window.SP_REACT.createElement("div", { style: { fontWeight: 600, marginBottom: "2px" } }, "Save current as a profile"),
                window.SP_REACT.createElement(TextRow, { label: "Profile name", value: newName, onChange: setNewName }),
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy || !newName.trim(), onClick: saveAsProfile }, "Save as profile"))) : null,
            msg ? window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.8, margin: "8px 0" } }, msg) : null,
            window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => closeModal?.(), style: { marginTop: "6px" } }, "Close")));
    };

    // Pair a Moonlight client with Docky's Sunshine. If no Sunshine login is stored
    // yet, first set one (Docky takes ownership of the credentials); then submit the
    // PIN Moonlight shows.
    const PairModal = ({ closeModal, credsStored, onState }) => {
        const [mode, setMode] = react.useState(credsStored ? "pair" : "login");
        const [user, setUser] = react.useState("docky");
        const [pass, setPass] = react.useState("");
        const [pin, setPin] = react.useState("");
        const [name, setName] = react.useState("");
        const [busy, setBusy] = react.useState(false);
        const [msg, setMsg] = react.useState("");
        const [clients, setClients] = react.useState([]);
        function refreshClients() {
            call("sunshine_clients")
                .then((r) => {
                if (r && r.clients)
                    setClients(r.clients);
            })
                .catch(() => { });
        }
        react.useEffect(() => {
            if (credsStored)
                refreshClients();
        }, []);
        function unpairOne(uuid) {
            setBusy(true);
            setMsg("Unpairing…");
            call("sunshine_unpair", { uuid })
                .then((r) => {
                setBusy(false);
                setMsg((r && r.message) || "done");
                refreshClients();
            })
                .catch((e) => {
                setBusy(false);
                setMsg("Error: " + errText(e));
            });
        }
        function setEnabled(uuid, enabled) {
            setBusy(true);
            setMsg(enabled ? "Enabling…" : "Disabling…");
            call("sunshine_set_client_enabled", { uuid, enabled })
                .then((r) => {
                setBusy(false);
                setMsg((r && r.message) || "done");
                refreshClients();
            })
                .catch((e) => {
                setBusy(false);
                setMsg("Error: " + errText(e));
            });
        }
        function unpairAll() {
            setBusy(true);
            setMsg("Unpairing all…");
            call("sunshine_unpair_all")
                .then((r) => {
                setBusy(false);
                setMsg((r && r.message) || "done");
                refreshClients();
            })
                .catch((e) => {
                setBusy(false);
                setMsg("Error: " + errText(e));
            });
        }
        function saveLogin() {
            setBusy(true);
            setMsg("Setting login…");
            call("set_sunshine_login", { username: user, password: pass })
                .then((r) => {
                setBusy(false);
                setMsg((r && r.message) || (r && r.ok ? "Login set" : "Failed"));
                if (r && r.ok) {
                    if (r.state)
                        onState(r.state);
                    setMode("pair");
                    refreshClients(); // a login may already have paired devices to show
                }
            })
                .catch((e) => {
                setBusy(false);
                setMsg("Error: " + errText(e));
            });
        }
        function doPair() {
            setBusy(true);
            setMsg("Pairing…");
            call("sunshine_pair", { pin, name })
                .then((r) => {
                setBusy(false);
                setMsg((r && r.message) || (r && r.ok ? "Paired" : "Failed"));
                if (r && r.ok) {
                    setPin("");
                    refreshClients();
                }
            })
                .catch((e) => {
                setBusy(false);
                setMsg("Error: " + errText(e));
            });
        }
        return (window.SP_REACT.createElement(deckyFrontendLib.ModalRoot, { onCancel: closeModal, onEscKeypress: closeModal },
            window.SP_REACT.createElement("div", { style: { fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" } }, "Pair a device"),
            mode === "login" ? (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.7, marginBottom: "4px" } }, "Set a Sunshine login (used to authorize pairing). This resets Sunshine's username/password \u2014 existing paired devices are kept."),
                window.SP_REACT.createElement(TextRow, { label: "Username", value: user, onChange: setUser }),
                window.SP_REACT.createElement(TextRow, { label: "Password", value: pass, onChange: setPass, password: true }),
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy || !user.trim() || !pass, onClick: saveLogin }, "Save login"))) : (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.7, marginBottom: "4px" } }, "In Moonlight, select this Deck \u2014 it shows a PIN. Enter that PIN here."),
                window.SP_REACT.createElement(TextRow, { label: "PIN", value: pin, onChange: setPin }),
                window.SP_REACT.createElement(TextRow, { label: "Device name (optional)", value: name, onChange: setName }),
                window.SP_REACT.createElement("div", { style: { display: "flex", gap: "8px" } },
                    window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy || !pin.trim(), onClick: doPair }, "Pair"),
                    window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => setMode("login") }, "Change login")),
                window.SP_REACT.createElement("div", { style: { fontWeight: 600, marginTop: "12px", marginBottom: "2px" } }, "Paired devices"),
                clients.length === 0 ? (window.SP_REACT.createElement("div", { style: { opacity: 0.6, fontSize: "0.85em" } }, "None")) : (clients.map((c) => {
                    const enabled = c.enabled !== false;
                    return (window.SP_REACT.createElement("div", { key: c.uuid, style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginTop: "4px" } },
                        window.SP_REACT.createElement("span", { style: { opacity: enabled ? 1 : 0.5 } },
                            c.name || c.uuid,
                            enabled ? "" : " (disabled)"),
                        window.SP_REACT.createElement("div", { style: { display: "flex", gap: "6px" } },
                            window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { style: { width: "7em" }, disabled: busy, onClick: () => setEnabled(c.uuid, !enabled) }, enabled ? "Disable" : "Enable"),
                            window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { style: { width: "7em" }, disabled: busy, onClick: () => unpairOne(c.uuid) }, "Unpair"))));
                })),
                clients.length > 0 ? (window.SP_REACT.createElement("div", { style: { marginTop: "6px" } },
                    window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: unpairAll }, "Unpair all"))) : null)),
            msg ? window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.85, marginTop: "8px" } }, msg) : null,
            window.SP_REACT.createElement("div", { style: { marginTop: "10px" } },
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: () => closeModal && closeModal() }, "Close"))));
    };

    const Row = ({ label, value }) => (window.SP_REACT.createElement("div", { style: {
            display: "flex",
            justifyContent: "space-between",
            gap: "12px",
            padding: "8px 0",
            borderBottom: "1px solid rgba(255,255,255,0.1)",
        } },
        window.SP_REACT.createElement("span", { style: { opacity: 0.7 } }, label),
        window.SP_REACT.createElement("span", { style: { fontWeight: 600, textAlign: "right" } }, value)));
    // Read-only popup with the Docky status fields that used to sit in the panel.
    const StatusModal = ({ closeModal, state, activeName }) => {
        const sunshine = state.sunshine
            ? state.sunshine.running
                ? "Streaming"
                : state.sunshine.installed
                    ? "Installed"
                    : "Not installed"
            : "—";
        return (window.SP_REACT.createElement(deckyFrontendLib.ModalRoot, { onCancel: closeModal, onEscKeypress: closeModal },
            window.SP_REACT.createElement("div", { style: { fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" } }, "Docky status"),
            window.SP_REACT.createElement(Row, { label: "Environment", value: state.docked ? "Docked (external display)" : "Handheld" }),
            window.SP_REACT.createElement(Row, { label: "Active mode", value: activeName }),
            window.SP_REACT.createElement(Row, { label: "Sunshine", value: sunshine })));
    };

    function DockIcon() {
        return (window.SP_REACT.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "currentColor" },
            window.SP_REACT.createElement("path", { d: "M4 5h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5v2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v7h16V7H4z" })));
    }
    // The Docky brand mark: a navy badge with a white "dock" arch, a blue screen dot,
    // and a blue dock cradle. Used as the plugin icon. Sized to fill the icon slot
    // (badge near full-bleed, mark enlarged) so it reads at the same scale as other
    // Decky plugin icons; the brighter badge + border keep it visible on the dark
    // panel background, where the old darker navy blended in.
    function DockyLogo() {
        return (window.SP_REACT.createElement("svg", { width: "1em", height: "1em", viewBox: "0 0 32 32" },
            window.SP_REACT.createElement("defs", null,
                window.SP_REACT.createElement("linearGradient", { id: "dockyBg", x1: "0", y1: "0", x2: "0", y2: "1" },
                    window.SP_REACT.createElement("stop", { offset: "0", stopColor: "#2a3548" }),
                    window.SP_REACT.createElement("stop", { offset: "1", stopColor: "#1a212d" }))),
            window.SP_REACT.createElement("rect", { x: "1", y: "1", width: "30", height: "30", rx: "8", fill: "url(#dockyBg)" }),
            window.SP_REACT.createElement("rect", { x: "1.5", y: "1.5", width: "29", height: "29", rx: "7.5", fill: "none", stroke: "#4a5a78", strokeWidth: "1" }),
            window.SP_REACT.createElement("path", { d: "M8 24 V11 Q8 5.3 13.7 5.3 H18.3 Q24 5.3 24 11 V24", fill: "none", stroke: "#f1f4fa", strokeWidth: "4.4", strokeLinecap: "round", strokeLinejoin: "round" }),
            window.SP_REACT.createElement("circle", { cx: "16", cy: "14.8", r: "3.4", fill: "#5b7cf0" }),
            window.SP_REACT.createElement("path", { d: "M5.3 21.7 Q16 26.9 26.7 21.7", fill: "none", stroke: "#5b7cf0", strokeWidth: "3.4", strokeLinecap: "round" })));
    }
    // Small on/off "LED" shown on buttons whose task carries a live boolean state.
    const StatusDot = ({ on }) => (window.SP_REACT.createElement("span", { style: {
            display: "inline-block",
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            flexShrink: 0,
            background: on ? "#52d669" : "#555",
            boxShadow: on ? "0 0 6px #52d669" : "none",
        } }));
    function InfoIcon() {
        return (window.SP_REACT.createElement("svg", { width: "1.1em", height: "1.1em", viewBox: "0 0 24 24", fill: "currentColor" },
            window.SP_REACT.createElement("path", { d: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" })));
    }
    function ReloadIcon() {
        return (window.SP_REACT.createElement("svg", { width: "1.2em", height: "1.2em", viewBox: "0 0 24 24", fill: "currentColor" },
            window.SP_REACT.createElement("path", { d: "M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" })));
    }
    function SettingsIcon() {
        return (window.SP_REACT.createElement("svg", { width: "1.2em", height: "1.2em", viewBox: "0 0 24 24", fill: "currentColor" },
            window.SP_REACT.createElement("path", { d: "M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.34.68.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.58-.24 1.12-.56 1.62-.94l2.39.96c.26.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" })));
    }
    function RestartIcon() {
        return (window.SP_REACT.createElement("svg", { width: "1.2em", height: "1.2em", viewBox: "0 0 24 24", fill: "currentColor" },
            window.SP_REACT.createElement("path", { d: "M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" })));
    }
    function PlayIcon() {
        return (window.SP_REACT.createElement("svg", { width: "1.2em", height: "1.2em", viewBox: "0 0 24 24", fill: "currentColor" },
            window.SP_REACT.createElement("path", { d: "M8 5v14l11-7z" })));
    }
    function StopIcon() {
        return (window.SP_REACT.createElement("svg", { width: "1.2em", height: "1.2em", viewBox: "0 0 24 24", fill: "currentColor" },
            window.SP_REACT.createElement("path", { d: "M6 6h12v12H6z" })));
    }
    // Compact icon button for action rows. Omit `label` for an icon-only button.
    const IconButton = ({ label, flex, disabled, onClick, children }) => (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: disabled, onClick: onClick, style: {
            flex: flex ?? 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            padding: "6px",
        } },
        children,
        label ? window.SP_REACT.createElement("span", { style: { fontSize: "0.85em" } }, label) : null));
    // Clickable section header that expands/collapses the rows below it. Styled to
    // read like a PanelSection title but works with the gamepad (it's a button).
    const SectionHeader = ({ title, open, onToggle, }) => (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { onClick: onToggle, style: {
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 8px",
            minHeight: 0,
        } },
        window.SP_REACT.createElement("span", { style: { fontWeight: 700, fontSize: "0.85em", letterSpacing: "0.05em", textTransform: "uppercase", opacity: 0.85 } }, title),
        window.SP_REACT.createElement("span", { style: { opacity: 0.7 } }, open ? "▾" : "▸")));
    const Content = () => {
        const [state, setState] = react.useState(null);
        const [busy, setBusy] = react.useState(false);
        const [msg, setMsg] = react.useState("");
        const [favOpen, setFavOpen] = react.useState(false);
        const [triggersOpen, setTriggersOpen] = react.useState(false);
        const [fanOpen, setFanOpen] = react.useState(false);
        const [tdpOpen, setTdpOpen] = react.useState(false);
        const [sunshineOpen, setSunshineOpen] = react.useState(false);
        // Local draft for the TDP manual slider (committed on "Apply").
        const [tdpDraft, setTdpDraft] = react.useState(null);
        function refresh() {
            return call("get_state", {})
                .then(setState)
                .catch((err) => setState({ error: errText(err) }));
        }
        // Mirror `busy` into a ref so the polling interval can read the latest value
        // without re-subscribing.
        const busyRef = react.useRef(false);
        react.useEffect(() => {
            busyRef.current = busy;
        }, [busy]);
        // A modal (editor, fan curve, pairing, status) owns the source of truth while
        // it's open and calls back with the authoritative state when it closes. The
        // background poll must NOT run underneath it: a get_state landing mid-edit
        // would replace what the user is looking at with stale backend state, and — for
        // FanModal/PairModal, which don't guarantee they setState last — could win the
        // race against the modal's own onSaved. showModal returns a handle; we count
        // opens/closes so nested or rapid opens can't leave the poll wedged off.
        const modalCountRef = react.useRef(0);
        // Wrap showModal so every modal this panel opens increments the poll-pause
        // count for its lifetime, whatever closes it (Save, Cancel, back button).
        function openModal(node) {
            modalCountRef.current += 1;
            const inst = deckyFrontendLib.showModal(
            // decky's showModal injects closeModal; preserve any the node already has.
            node);
            // showModal doesn't give a close callback, so patch the returned instance's
            // Close to decrement. Guard so a double-close can't drive the count negative.
            const origClose = inst && inst.Close ? inst.Close.bind(inst) : null;
            if (inst) {
                let closed = false;
                inst.Close = () => {
                    if (!closed) {
                        closed = true;
                        modalCountRef.current = Math.max(0, modalCountRef.current - 1);
                    }
                    if (origClose)
                        origClose();
                };
            }
            return inst;
        }
        react.useEffect(() => {
            refresh();
            // Skip the periodic poll while a mutation is in flight OR a modal is open —
            // otherwise a refresh can land after an action (or mid-edit) and clobber it
            // with stale state (toggles snapping back, momentary flicker, an edit view
            // replaced underneath the user).
            const iv = setInterval(() => {
                if (!busyRef.current && modalCountRef.current === 0)
                    refresh();
            }, 4000);
            return () => clearInterval(iv);
        }, []);
        // Every mutation handler funnels through here so the busy/refresh/error
        // discipline is defined once. `optimistic` lets a caller paint an expected
        // state immediately and hands back the rollback: on any failure we restore the
        // exact prior snapshot rather than leaving an optimistic value stranded until
        // the next poll (or forever, if the poll also fails). The response's own
        // `state` is authoritative when present; otherwise we refresh().
        function mutate(method, args, opts = {}) {
            const undo = opts.optimistic ? opts.optimistic() : null;
            setBusy(true);
            if (opts.pending)
                setMsg(opts.pending);
            return call(method, args)
                .then((r) => {
                setBusy(false);
                if (r && r.state)
                    setState(r.state);
                else
                    refresh();
                const text = opts.done ? opts.done(r) : (r && r.message) || (opts.pending || method);
                setMsg(text);
                if (opts.toastResult)
                    toast(text);
                return r;
            })
                .catch((err) => {
                setBusy(false);
                if (undo)
                    undo(); // revert the optimistic paint; the failure stands
                const text = "Error: " + errText(err);
                setMsg(text);
                if (opts.toastResult)
                    toast(text);
                return undefined;
            });
        }
        function doCall(method, args, label) {
            mutate(method, args, {
                pending: label + "…",
                done: (r) => {
                    const text = summarize(r && r.result);
                    toast(text);
                    return text;
                },
            });
        }
        function toggleTrigger(key, label, v) {
            mutate("set_trigger", { key, enabled: v }, {
                done: () => label + " " + (v ? "ON" : "OFF"),
                // Optimistically flip the switch so it doesn't visibly lag the (root)
                // backend round-trip; undo restores the prior value on failure.
                optimistic: () => {
                    let prev;
                    setState((s) => {
                        if (!s)
                            return s;
                        prev = s.settings?.[key];
                        return { ...s, settings: { ...(s.settings || {}), [key]: v } };
                    });
                    return () => setState((s) => s ? { ...s, settings: { ...(s.settings || {}), [key]: prev } } : s);
                },
            });
        }
        function sunshineControl(method, verb) {
            mutate(method, {}, {
                pending: verb + " Sunshine…",
                done: (r) => (r && r.message ? r.message : verb + " done"),
            });
        }
        // Fan/TDP quick controls and the Sunshine toggles: backend returns
        // {message,state}. For the toggles we paint optimistically and roll back on
        // error, so a rejected change doesn't leave the switch lying about reality.
        function fanTdpCall(method, args, label) {
            mutate(method, args, {
                pending: label + "…",
                done: (r) => (r && r.message ? r.message : label),
            });
        }
        // A Sunshine setting toggle keyed under state.sunshine.<key>. Optimistic with
        // rollback, matching the trigger toggles.
        function sunshineToggle(method, key, v, label) {
            mutate(method, { enabled: v }, {
                pending: label + "…",
                done: (r) => (r && r.message ? r.message : label),
                optimistic: () => {
                    let prev;
                    setState((s) => {
                        if (!s)
                            return s;
                        prev = s.sunshine?.[key];
                        return { ...s, sunshine: { ...(s.sunshine || {}), [key]: v } };
                    });
                    return () => setState((s) => s ? { ...s, sunshine: { ...(s.sunshine || {}), [key]: prev } } : s);
                },
            });
        }
        function setFanMode(mode) {
            fanTdpCall("set_fan_mode", { mode }, "Fan: " + mode);
        }
        function releaseControl() {
            // A deliberate one-shot action — toast so it's clearly acknowledged (the
            // inline status line is faint and far from the button, and when nothing was
            // being enforced there's no visible hardware change to confirm it worked).
            mutate("release_control", {}, {
                pending: "Handing control to SteamOS…",
                done: (r) => (r && r.message) || "Handed control back to SteamOS",
                toastResult: true,
            });
        }
        function openEditor(initialTab) {
            // Pause the poll for the whole fetch+modal lifetime, not just the fetch:
            // increment now, and hand a decrementing close down to the modal. (openModal
            // handles that; here we also cover the window between the click and the
            // config arriving.) Kept as its own count via openModal below.
            setBusy(true);
            call("get_config", {})
                .then((r) => {
                setBusy(false);
                const config = r && r.config ? r.config : { actions: {}, modes: {}, settings: {} };
                openModal(window.SP_REACT.createElement(EditorModal, { initialConfig: config, initialTab: initialTab, profiles: (state && state.pcsx2_profiles) || [], installedPlugins: (state && state.installed_plugins) || [], onSaved: (st) => {
                        if (st)
                            setState(st);
                        else
                            refresh();
                    } }));
            })
                .catch((err) => {
                setBusy(false);
                setMsg("Error: " + errText(err));
            });
        }
        if (!state) {
            return (window.SP_REACT.createElement(deckyFrontendLib.PanelSection, { title: "Docky" },
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement("div", null, "Loading\u2026"))));
        }
        if (state.error) {
            return (window.SP_REACT.createElement(deckyFrontendLib.PanelSection, { title: "Docky" },
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement("div", { style: { color: "orange" } }, state.error)),
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(deckyFrontendLib.ButtonItem, { layout: "below", onClick: refresh }, "Retry"))));
        }
        const sett = state.settings || {};
        const modes = state.modes || [];
        const favorites = state.favorites || [];
        const fanProfiles = state.fanProfiles || [];
        const tdpProfiles = state.tdpProfiles || [];
        const fan = state.fan;
        const tdp = state.tdp;
        const sun = state.sunshine;
        const activeName = (() => {
            const found = modes.find((x) => x.id === state.activeMode);
            return found ? found.name : state.activeMode || "none";
        })();
        return (window.SP_REACT.createElement(window.SP_REACT.Fragment, null,
            window.SP_REACT.createElement(deckyFrontendLib.PanelSection, { title: "Docky" },
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px" } },
                        window.SP_REACT.createElement(IconButton, { flex: 0.5, disabled: busy, onClick: () => openModal(window.SP_REACT.createElement(StatusModal, { state: state, activeName: activeName })) },
                            window.SP_REACT.createElement(InfoIcon, null)),
                        window.SP_REACT.createElement(IconButton, { label: "Reload", disabled: busy, onClick: refresh },
                            window.SP_REACT.createElement(ReloadIcon, null)),
                        window.SP_REACT.createElement(IconButton, { label: "Settings", disabled: busy, onClick: () => openEditor() },
                            window.SP_REACT.createElement(SettingsIcon, null)))),
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(deckyFrontendLib.ButtonItem, { layout: "below", disabled: busy, description: "Fan \u2192 auto and TDP cap lifted; SteamOS/BIOS defaults take over", onClick: releaseControl }, "\u23CF Hand control back to SteamOS"))),
            window.SP_REACT.createElement(deckyFrontendLib.PanelSection, null,
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(SectionHeader, { title: "Favorites", open: favOpen, onToggle: () => setFavOpen(!favOpen) })),
                !favOpen ? null : favorites.length ? (favorites.map((f) => {
                    const isActive = f.kind === "mode" && f.id === state.activeMode;
                    const hasStatus = typeof f.status === "boolean";
                    return (window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, { key: "f_" + f.kind + "_" + f.id },
                        window.SP_REACT.createElement(deckyFrontendLib.ButtonItem, { layout: "below", disabled: busy || f.missing, description: hasStatus
                                ? "Action · " + (f.status ? "on" : "off")
                                : f.kind === "mode"
                                    ? isActive ? "Mode · active" : "Mode"
                                    : "Action", onClick: () => f.kind === "mode"
                                ? doCall("activate_mode", { mode_id: f.id }, "Switching to " + f.name)
                                : doCall("run_action", { action_id: f.id }, "Running " + f.name) },
                            window.SP_REACT.createElement("span", { style: { display: "flex", alignItems: "center", gap: "8px" } },
                                hasStatus ? window.SP_REACT.createElement(StatusDot, { on: !!f.status }) : null,
                                window.SP_REACT.createElement("span", null, (hasStatus ? "" : isActive ? "✓ " : "★ ") +
                                    (f.kind === "mode" ? "" : (f.verb ? f.verb : "Run") + ": ") +
                                    f.name +
                                    (f.missing ? " (missing)" : ""))))));
                })) : (window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement("div", { style: { opacity: 0.7, padding: "0 4px" } }, "No favorites yet. Open Settings (gear) \u2192 Favorites to pin actions and modes here.")))),
            window.SP_REACT.createElement(deckyFrontendLib.PanelSection, null,
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(SectionHeader, { title: "Sunshine", open: sunshineOpen, onToggle: () => setSunshineOpen(!sunshineOpen) })),
                !sunshineOpen ? null : (window.SP_REACT.createElement(window.SP_REACT.Fragment, null,
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px" } },
                            window.SP_REACT.createElement(IconButton, { label: "Pair", flex: 2, disabled: busy || !(sun && sun.running), onClick: () => openModal(window.SP_REACT.createElement(PairModal, { credsStored: !!(sun && sun.credsStored), onState: (st) => st && setState(st) })) },
                                window.SP_REACT.createElement(DockIcon, null)),
                            window.SP_REACT.createElement(IconButton, { disabled: busy || !(sun && sun.running), onClick: () => sunshineControl("sunshine_restart", "Restarting") },
                                window.SP_REACT.createElement(RestartIcon, null)),
                            window.SP_REACT.createElement(IconButton, { disabled: busy || !(sun && sun.installed), onClick: () => sun && sun.running
                                    ? sunshineControl("sunshine_stop", "Stopping")
                                    : sunshineControl("sunshine_start", "Starting") }, sun && sun.running ? window.SP_REACT.createElement(StopIcon, null) : window.SP_REACT.createElement(PlayIcon, null)))),
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: "Fix stretched image when docked", description: "Forces gamescope composition; re-applied automatically after reboots.", checked: !!(sun && sun.forceComposition), disabled: busy, onChange: (v) => sunshineToggle("set_force_composition", "forceComposition", v, "Updating composition") })),
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: "HDR (Game Mode)", description: "Enables HDR output; re-applied automatically after reboots. Display and content must support HDR.", checked: !!(sun && sun.forceHdr), disabled: busy, onChange: (v) => sunshineToggle("set_force_hdr", "forceHdr", v, "Updating HDR") })),
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: "Keep Sunshine running", 
                            // Defaults ON: watchdog is enabled unless the backend explicitly
                            // sends watchdog:false. This is the one toggle that inverts (the
                            // others default off via !!), because a missing value here should
                            // read as "the safety net is on", not "off".
                            description: "Relaunch Sunshine automatically if it crashes.", checked: !(sun && sun.watchdog === false), disabled: busy, onChange: (v) => sunshineToggle("set_sunshine_watchdog", "watchdog", v, "Updating watchdog") }))))),
            window.SP_REACT.createElement(deckyFrontendLib.PanelSection, null,
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(SectionHeader, { title: "Fan", open: fanOpen, onToggle: () => setFanOpen(!fanOpen) })),
                !fanOpen ? null : (window.SP_REACT.createElement(window.SP_REACT.Fragment, null,
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement("div", { style: { display: "flex", justifyContent: "space-between", padding: "0 4px 4px", fontSize: "0.9em" } },
                            window.SP_REACT.createElement("span", { style: { opacity: 0.75 } },
                                typeof fan?.tempC === "number" ? fan.tempC + "°C" : "—°C",
                                " \u00B7",
                                " ",
                                typeof fan?.rpm === "number" ? fan.rpm + " RPM" : "— RPM"),
                            window.SP_REACT.createElement("span", { style: { fontWeight: 600 } }, fan?.profile
                                ? (fanProfiles.find((p) => p.id === fan.profile)?.name || fan.profile)
                                : (fan?.mode || "auto").toUpperCase()))),
                    fanProfiles.length ? (window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "Apply profile", rgOptions: [{ data: "auto", label: "Auto (SteamOS)" }].concat(fanProfiles.map((p) => ({ data: p.id, label: p.name }))), selectedOption: fan?.profile || "auto", onChange: (o) => fanTdpCall("apply_fan_profile", { profile_id: o.data }, "Fan profile") }))) : null,
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "6px" } }, ["auto", "curve", "manual"].map((m) => (window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { key: m, disabled: busy || fan?.available === false, onClick: () => setFanMode(m), style: {
                                flex: 1,
                                minWidth: 0,
                                padding: "6px 4px",
                                fontWeight: (fan?.mode || "auto") === m ? 700 : 400,
                                background: (fan?.mode || "auto") === m ? "rgba(91,124,240,0.35)" : "rgba(255,255,255,0.06)",
                                border: (fan?.mode || "auto") === m ? "1px solid #5b7cf0" : "1px solid transparent",
                            } }, m === "auto" ? "Auto" : m === "curve" ? "Curve" : "Manual"))))),
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.ButtonItem, { layout: "below", disabled: busy, onClick: () => openModal(window.SP_REACT.createElement(FanModal, { onSaved: (st) => { if (st)
                                    setState(st);
                                else
                                    refresh(); } })) }, "Edit fan curve\u2026")),
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.ButtonItem, { layout: "below", disabled: busy, onClick: () => openEditor("fan") }, "Manage fan profiles\u2026"))))),
            window.SP_REACT.createElement(deckyFrontendLib.PanelSection, null,
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(SectionHeader, { title: "TDP", open: tdpOpen, onToggle: () => setTdpOpen(!tdpOpen) })),
                !tdpOpen ? null : tdp?.available === false ? (window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement("div", { style: { opacity: 0.7, padding: "0 4px" } }, "No adjustable TDP on this device."))) : (window.SP_REACT.createElement(window.SP_REACT.Fragment, null,
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement("div", { style: { display: "flex", justifyContent: "space-between", padding: "0 4px 4px", fontSize: "0.9em" } },
                            window.SP_REACT.createElement("span", { style: { opacity: 0.75 } }, typeof tdp?.watts === "number" ? "Now " + tdp.watts + "W" : "—W"),
                            window.SP_REACT.createElement("span", { style: { fontWeight: 600 } }, tdp?.profile
                                ? (tdpProfiles.find((p) => p.id === tdp.profile)?.name || tdp.profile)
                                : "Manual"))),
                    tdpProfiles.length ? (window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { label: "Apply profile", rgOptions: tdpProfiles.map((p) => ({ data: p.id, label: p.name + (p.watts ? " (" + p.watts + "W)" : "") })), selectedOption: tdp?.profile || "", onChange: (o) => { setTdpDraft(null); fanTdpCall("apply_tdp_profile", { profile_id: o.data }, "TDP profile"); } }))) : null,
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(Stepper, { label: "Manual TDP (W)", value: tdpDraft ?? tdp?.setWatts ?? 15, min: 3, max: tdp?.max || 15, step: 1, unit: "W", disabled: busy, onChange: (v) => setTdpDraft(v) })),
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.ButtonItem, { layout: "below", disabled: busy, onClick: () => {
                                const w = tdpDraft ?? tdp?.setWatts ?? 15;
                                setTdpDraft(null); // let the polled hardware value drive the display again
                                fanTdpCall("set_tdp_watts", { watts: w }, "Set TDP");
                            } },
                            "Apply ",
                            tdpDraft ?? tdp?.setWatts ?? 15,
                            "W")),
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: "Keep enforced", description: "Re-apply continuously so Steam's TDP slider can't override it", checked: !!tdp?.enforce, disabled: busy, onChange: (v) => fanTdpCall("set_tdp_enforce", { on: v }, "TDP enforce " + (v ? "on" : "off")) })),
                    window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                        window.SP_REACT.createElement(deckyFrontendLib.ButtonItem, { layout: "below", disabled: busy, onClick: () => openEditor("tdp") }, "Manage TDP profiles\u2026"))))),
            window.SP_REACT.createElement(deckyFrontendLib.PanelSection, null,
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(SectionHeader, { title: "Triggers", open: triggersOpen, onToggle: () => setTriggersOpen(!triggersOpen) })),
                !triggersOpen
                    ? null
                    : [
                        { key: "autoDockDetection", label: "Dock / undock", desc: "Switch modes when you dock or undock" },
                        { key: "autoAcDetection", label: "AC power", desc: "Switch modes when AC power connects/disconnects" },
                        { key: "autoControllerDetection", label: "External controller", desc: "Switch modes when a controller connects/disconnects" },
                        { key: "autoResume", label: "Resume from sleep", desc: "Re-apply a mode when the Deck wakes" },
                        { key: "autoStartup", label: "Startup", desc: "Apply a mode when Docky loads at boot" },
                    ].map((t) => (window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, { key: t.key },
                        window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { label: t.label, description: t.desc, checked: !!sett[t.key], disabled: busy, onChange: (v) => toggleTrigger(t.key, t.label, v) })))),
                triggersOpen ? (window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement("div", { style: { fontSize: "0.7em", opacity: 0.6, padding: "0 4px" } }, "Map each trigger to a mode in Settings (gear) \u2192 Triggers."))) : null),
            msg ? (window.SP_REACT.createElement(deckyFrontendLib.PanelSection, null,
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement("div", { style: { fontSize: "0.75em", opacity: 0.8, padding: "0 16px" } }, msg)))) : null));
    };
    var index = deckyFrontendLib.definePlugin((serverApi) => {
        setServer(serverApi);
        return {
            title: window.SP_REACT.createElement("div", { className: "Title" }, "Docky"),
            content: window.SP_REACT.createElement(Content, null),
            icon: window.SP_REACT.createElement(DockyLogo, null),
            onDismount() { },
        };
    });

    return index;

})(SP_REACT, DFL);
