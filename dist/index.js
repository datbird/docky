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
            return "Failed: " + fail[0].message;
        if (skip.length)
            return "Done (" + skip.length + " skipped): " + skip[0].message;
        return "Done — " + tasks.length + " task" + (tasks.length === 1 ? "" : "s") + " OK";
    }

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
                    placeholder: "~/.var/app/net.retrodeck.retrodeck/config/PCSX2/inputprofiles",
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
            fields: [{ key: "watts", kind: "text", label: "TDP (watts, e.g. 15)" }],
            summary: (t) => "TDP: " + (t.watts ? t.watts + "W" : "?"),
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
    const TextRow = (props) => (window.SP_REACT.createElement(deckyFrontendLib.Field, { label: props.label, childrenLayout: "below", bottomSeparator: "none" },
        window.SP_REACT.createElement(deckyFrontendLib.TextField, { value: props.value || "", onChange: (e) => props.onChange(e.target.value) })));

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
    const AddTask = ({ profiles, busy, onAdd, taskSettings, onChangeTaskSetting, installedPlugins }) => {
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
            const task = { type };
            def.fields.forEach((f) => {
                const val = vals[f.key];
                if (f.kind === "bool") {
                    if (val)
                        task[f.key] = true;
                }
                else if (val !== undefined && val !== "") {
                    task[f.key] = val;
                }
                else if (f.kind === "select" && f.options && f.options.length) {
                    // Untouched dropdown: persist the shown default (its first option).
                    task[f.key] = f.options[0].data;
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
                return (window.SP_REACT.createElement(deckyFrontendLib.ToggleField, { key: f.key, label: f.label, checked: !!vals[f.key], onChange: (val) => setField(f.key, val) }));
            }
            if (f.kind === "profile") {
                if (!profiles.length) {
                    return (window.SP_REACT.createElement(deckyFrontendLib.Field, { key: f.key, label: f.label },
                        window.SP_REACT.createElement("span", { style: { opacity: 0.7 } }, "No PCSX2 profiles found")));
                }
                return (window.SP_REACT.createElement(deckyFrontendLib.DropdownItem, { key: f.key, label: f.label, rgOptions: profiles.map((p) => ({ data: p, label: p })), selectedOption: vals[f.key] || profiles[0], onChange: (o) => setField(f.key, o.data) }));
            }
            if (f.kind === "select") {
                const opts = f.options || [];
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
    function renderTaskField(f, value, onChange, profiles) {
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
        if (f.kind === "select") {
            const opts = f.options || [];
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
    const EditorModal = ({ closeModal, initialConfig, profiles, installedPlugins, onSaved }) => {
        const [cfg, setCfg] = react.useState(clone(initialConfig));
        const [dirty, setDirty] = react.useState(false);
        const [busy, setBusy] = react.useState(false);
        const [msg, setMsg] = react.useState("");
        const [tab, setTab] = react.useState("actions");
        const [selAction, setSelAction] = react.useState(null);
        const [selMode, setSelMode] = react.useState(null);
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
            call("save_config", { config: cfg })
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
                    setMsg("Save failed: " + (r && r.error));
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
        const actionIds = Object.keys(cfgActions);
        const modeIds = Object.keys(cfgModes);
        const modeOpts = [{ data: "", label: "(none)" }].concat(modeIds.map((mid) => ({ data: mid, label: cfgModes[mid].name || mid })));
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
                            return (window.SP_REACT.createElement(Card, { key: ti, title: d ? d.label : task.type },
                                window.SP_REACT.createElement("div", { style: { fontSize: "0.78em", opacity: 0.6, marginBottom: "4px" } }, summarizeTask(task)),
                                fields.map((f) => renderTaskField(f, task[f.key], (v) => setField(f, v), profiles)),
                                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { style: { marginTop: "6px" }, disabled: busy, onClick: () => mutate((n) => { n.actions[aid].tasks.splice(ti, 1); }) }, "Remove task")));
                        })),
                        window.SP_REACT.createElement(AddTask, { profiles: profiles, busy: busy, onAdd: (task) => mutate((n) => {
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
                    return (window.SP_REACT.createElement(deckyFrontendLib.Field, { key: key(f) + "_" + i, label: tag + ": " + name + (item ? "" : " (missing)"), bottomSeparator: "none" },
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
            const InfoRow = ({ label, value }) => (window.SP_REACT.createElement("div", { style: { display: "flex", justifyContent: "space-between", padding: "4px 0" } },
                window.SP_REACT.createElement("span", { style: { opacity: 0.7 } }, label),
                window.SP_REACT.createElement("span", { style: { fontWeight: 600 } }, value || "—")));
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
                window.SP_REACT.createElement(TabButton, { active: tab === "sunshine", label: "Sunshine", onClick: () => setTab("sunshine") }),
                window.SP_REACT.createElement(TabButton, { active: tab === "autodock", label: "Triggers", onClick: () => setTab("autodock") })),
            window.SP_REACT.createElement("div", { style: { maxHeight: "62vh", overflowY: "scroll", paddingRight: "6px" } },
                tab === "actions" ? renderActions() : null,
                tab === "modes" ? renderModes() : null,
                tab === "favorites" ? renderFavorites() : null,
                tab === "sunshine" ? renderSunshine() : null,
                tab === "autodock" ? renderAutoDock() : null)));
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
                setMsg("Error: " + e);
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
                setMsg("Error: " + e);
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
                setMsg("Error: " + e);
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
                }
            })
                .catch((e) => {
                setBusy(false);
                setMsg("Error: " + e);
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
                setMsg("Error: " + e);
            });
        }
        return (window.SP_REACT.createElement(deckyFrontendLib.ModalRoot, { onCancel: closeModal, onEscKeypress: closeModal },
            window.SP_REACT.createElement("div", { style: { fontSize: "1.3em", fontWeight: 700, marginBottom: "8px" } }, "Pair a device"),
            mode === "login" ? (window.SP_REACT.createElement("div", null,
                window.SP_REACT.createElement("div", { style: { fontSize: "0.8em", opacity: 0.7, marginBottom: "4px" } }, "Set a Sunshine login (used to authorize pairing). This resets Sunshine's username/password \u2014 existing paired devices are kept."),
                window.SP_REACT.createElement(TextRow, { label: "Username", value: user, onChange: setUser }),
                window.SP_REACT.createElement(TextRow, { label: "Password", value: pass, onChange: setPass }),
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
                window.SP_REACT.createElement(deckyFrontendLib.DialogButton, { disabled: busy, onClick: () => closeModal && closeModal() }, "Close"))));
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
        function refresh() {
            return call("get_state", {})
                .then(setState)
                .catch((err) => setState({ error: errText(err) }));
        }
        react.useEffect(() => {
            refresh();
            const iv = setInterval(refresh, 4000);
            return () => clearInterval(iv);
        }, []);
        function doCall(method, args, label) {
            setBusy(true);
            setMsg(label + "…");
            call(method, args)
                .then((r) => {
                setBusy(false);
                const text = summarize(r && r.result);
                setMsg(text);
                toast(text);
                if (r && r.state)
                    setState(r.state);
                else
                    refresh();
            })
                .catch((err) => {
                setBusy(false);
                const text = "Error: " + errText(err);
                setMsg(text);
                toast(text);
            });
        }
        function toggleTrigger(key, label, v) {
            setBusy(true);
            call("set_trigger", { key, enabled: v })
                .then((r) => {
                setBusy(false);
                if (r && r.state)
                    setState(r.state);
                else
                    refresh();
                setMsg(label + " " + (v ? "ON" : "OFF"));
            })
                .catch((err) => {
                setBusy(false);
                setMsg("Error: " + errText(err));
            });
        }
        function sunshineControl(method, verb) {
            setBusy(true);
            setMsg(verb + " Sunshine…");
            call(method, {})
                .then((r) => {
                setBusy(false);
                if (r && r.state)
                    setState(r.state);
                else
                    refresh();
                setMsg(r && r.message ? r.message : verb + " done");
            })
                .catch((err) => {
                setBusy(false);
                setMsg("Error: " + errText(err));
            });
        }
        function openEditor() {
            setBusy(true);
            call("get_config", {})
                .then((r) => {
                setBusy(false);
                const config = r && r.config ? r.config : { actions: {}, modes: {}, settings: {} };
                deckyFrontendLib.showModal(window.SP_REACT.createElement(EditorModal, { initialConfig: config, profiles: (state && state.pcsx2_profiles) || [], installedPlugins: (state && state.installed_plugins) || [], onSaved: (st) => {
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
        const activeName = (() => {
            const found = modes.filter((x) => x.id === state.activeMode)[0];
            return found ? found.name : state.activeMode || "none";
        })();
        return (window.SP_REACT.createElement(window.SP_REACT.Fragment, null,
            window.SP_REACT.createElement(deckyFrontendLib.PanelSection, { title: "Docky" },
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px" } },
                        window.SP_REACT.createElement(IconButton, { flex: 0.5, disabled: busy, onClick: () => deckyFrontendLib.showModal(window.SP_REACT.createElement(StatusModal, { state: state, activeName: activeName })) },
                            window.SP_REACT.createElement(InfoIcon, null)),
                        window.SP_REACT.createElement(IconButton, { label: "Reload", disabled: busy, onClick: refresh },
                            window.SP_REACT.createElement(ReloadIcon, null)),
                        window.SP_REACT.createElement(IconButton, { label: "Settings", disabled: busy, onClick: openEditor },
                            window.SP_REACT.createElement(SettingsIcon, null))))),
            window.SP_REACT.createElement(deckyFrontendLib.PanelSection, { title: "Sunshine" },
                window.SP_REACT.createElement(deckyFrontendLib.PanelSectionRow, null,
                    window.SP_REACT.createElement(deckyFrontendLib.Focusable, { "flow-children": "horizontal", style: { display: "flex", gap: "8px" } },
                        window.SP_REACT.createElement(IconButton, { label: "Pair", flex: 2, disabled: busy, onClick: () => deckyFrontendLib.showModal(window.SP_REACT.createElement(PairModal, { credsStored: !!(state.sunshine && state.sunshine.credsStored), onState: (st) => st && setState(st) })) },
                            window.SP_REACT.createElement(DockIcon, null)),
                        window.SP_REACT.createElement(IconButton, { disabled: busy || !(state.sunshine && state.sunshine.running), onClick: () => sunshineControl("sunshine_restart", "Restarting") },
                            window.SP_REACT.createElement(RestartIcon, null)),
                        window.SP_REACT.createElement(IconButton, { disabled: busy || !(state.sunshine && state.sunshine.installed), onClick: () => state.sunshine && state.sunshine.running
                                ? sunshineControl("sunshine_stop", "Stopping")
                                : sunshineControl("sunshine_start", "Starting") }, state.sunshine && state.sunshine.running ? (window.SP_REACT.createElement(StopIcon, null)) : (window.SP_REACT.createElement(PlayIcon, null)))))),
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
            icon: window.SP_REACT.createElement(DockIcon, null),
            onDismount() { },
        };
    });

    return index;

})(SP_REACT, DFL);
