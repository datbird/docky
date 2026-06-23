(function (React, deckyFrontendLib) {
  'use strict';

  var h = React.createElement;
  var Fragment = React.Fragment;
  var useState = React.useState;
  var useEffect = React.useEffect;

  var PanelSection = deckyFrontendLib.PanelSection;
  var PanelSectionRow = deckyFrontendLib.PanelSectionRow;
  var ButtonItem = deckyFrontendLib.ButtonItem;
  var ToggleField = deckyFrontendLib.ToggleField;
  var Field = deckyFrontendLib.Field;
  var TextField = deckyFrontendLib.TextField;
  var DropdownItem = deckyFrontendLib.DropdownItem;

  var server = null;

  function call(method, args) {
    return server.callPluginMethod(method, args || {}).then(function (res) {
      if (res && res.success) return res.result;
      throw new Error((res && res.result) || 'call failed');
    });
  }
  function toast(body) {
    try { server.toaster.toast({ title: 'Docky', body: body }); } catch (e) { /* noop */ }
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function slugify(name) {
    var s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return s || 'item';
  }
  function uniqueId(base, existing) {
    var id = base, n = 2;
    while (Object.prototype.hasOwnProperty.call(existing, id)) { id = base + '_' + n; n++; }
    return id;
  }

  // Built-in task types. The PCSX2 controller-profile task is the marquee one;
  // the rest are generic file/script ops. `fields` drives the little add-task form.
  var TASK_DEFS = [
    { type: 'pcsx2_profile', label: 'PCSX2 controller profile',
      fields: [
        { key: 'profile', kind: 'profile', label: 'Profile' },
        { key: 'force', kind: 'bool', label: 'Force (apply even while PCSX2 runs)' }
      ],
      summary: function (t) { return 'PCSX2 profile: ' + (t.profile || '?'); } },
    { type: 'run', label: 'Run command',
      fields: [ { key: 'command', kind: 'text', label: 'Command (shell)' },
                { key: 'cwd', kind: 'text', label: 'Working dir (optional)' } ],
      summary: function (t) { return 'run: ' + (t.command || (t.argv && t.argv.join(' ')) || '?'); } },
    { type: 'bash', label: 'Bash script',
      fields: [ { key: 'script', kind: 'text', label: 'Script' },
                { key: 'cwd', kind: 'text', label: 'Working dir (optional)' } ],
      summary: function (t) { return 'bash: ' + String(t.script || t.path || '').slice(0, 40); } },
    { type: 'python', label: 'Python script',
      fields: [ { key: 'script', kind: 'text', label: 'Script' },
                { key: 'cwd', kind: 'text', label: 'Working dir (optional)' } ],
      summary: function (t) { return 'python: ' + String(t.script || t.path || '').slice(0, 40); } },
    { type: 'copy', label: 'Copy file',
      fields: [ { key: 'src', kind: 'text', label: 'Source' },
                { key: 'dest', kind: 'text', label: 'Destination' } ],
      summary: function (t) { return 'copy: ' + t.src + ' → ' + t.dest; } },
    { type: 'move', label: 'Move file',
      fields: [ { key: 'src', kind: 'text', label: 'Source' },
                { key: 'dest', kind: 'text', label: 'Destination' } ],
      summary: function (t) { return 'move: ' + t.src + ' → ' + t.dest; } },
    { type: 'symlink', label: 'Symlink',
      fields: [ { key: 'target', kind: 'text', label: 'Target' },
                { key: 'link', kind: 'text', label: 'Link path' },
                { key: 'replace', kind: 'bool', label: 'Replace if it exists', def: true } ],
      summary: function (t) { return 'symlink: ' + t.link + ' → ' + t.target; } },
    { type: 'write', label: 'Write file',
      fields: [ { key: 'path', kind: 'text', label: 'Path' },
                { key: 'content', kind: 'text', label: 'Content' },
                { key: 'mode', kind: 'text', label: 'Mode (octal, optional)' } ],
      summary: function (t) { return 'write: ' + t.path; } },
    { type: 'delete', label: 'Delete path',
      fields: [ { key: 'path', kind: 'text', label: 'Path' },
                { key: 'recursive', kind: 'bool', label: 'Recursive (delete dirs)' } ],
      summary: function (t) { return 'delete: ' + t.path; } }
  ];
  function taskDef(type) {
    for (var i = 0; i < TASK_DEFS.length; i++) if (TASK_DEFS[i].type === type) return TASK_DEFS[i];
    return null;
  }
  function summarizeTask(t) {
    var d = taskDef(t.type);
    try { return d ? d.summary(t) : (t.type + ': ' + JSON.stringify(t)); }
    catch (e) { return t.type || 'task'; }
  }

  function DockIcon() {
    return h('svg', { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'currentColor' },
      h('path', { d: 'M4 5h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5v2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v7h16V7H4z' }));
  }

  function summarize(result) {
    if (!result) return 'Done';
    if (result.message) return result.message;
    var tasks = [];
    (result.actions || []).forEach(function (a) { (a.results || []).forEach(function (t) { tasks.push(t); }); });
    (result.results || []).forEach(function (t) { tasks.push(t); });
    if (!tasks.length) return result.ok ? 'OK' : 'Failed';
    var fail = tasks.filter(function (t) { return !t.ok; });
    var skip = tasks.filter(function (t) { return t.skipped; });
    if (fail.length) return 'Failed: ' + fail[0].message;
    if (skip.length) return 'Done (' + skip.length + ' skipped): ' + skip[0].message;
    return 'Done — ' + tasks.length + ' task' + (tasks.length === 1 ? '' : 's') + ' OK';
  }

  // ---- small reusable inputs ----

  function TextRow(props) {
    return h(Field, { label: props.label, childrenLayout: 'below', bottomSeparator: 'none' },
      h(TextField, { value: props.value || '', onChange: function (e) { props.onChange(e.target.value); } }));
  }

  // Add-task form for one action. Local state: chosen type + field values.
  function AddTask(props) {
    var t = useState('pcsx2_profile'); var type = t[0]; var setType = t[1];
    var v = useState({}); var vals = v[0]; var setVals = v[1];
    var def = taskDef(type);
    var profiles = props.profiles || [];

    function setField(k, val) { var nv = clone(vals); nv[k] = val; setVals(nv); }

    function add() {
      var task = { type: type };
      def.fields.forEach(function (f) {
        var val = vals[f.key];
        if (f.kind === 'bool') { if (val) task[f.key] = true; }
        else if (val !== undefined && val !== '') { task[f.key] = val; }
      });
      // sensible default for symlink.replace which defaults true in the engine
      props.onAdd(task);
      setVals({});
    }

    var fieldEls = def.fields.map(function (f) {
      if (f.kind === 'bool') {
        return h(PanelSectionRow, { key: f.key }, h(ToggleField, {
          label: f.label, checked: !!vals[f.key], onChange: function (val) { setField(f.key, val); }
        }));
      }
      if (f.kind === 'profile') {
        if (!profiles.length) {
          return h(PanelSectionRow, { key: f.key }, h(Field, { label: f.label },
            h('span', { style: { opacity: 0.7 } }, 'No PCSX2 profiles found')));
        }
        return h(PanelSectionRow, { key: f.key }, h(DropdownItem, {
          label: f.label,
          rgOptions: profiles.map(function (p) { return { data: p, label: p }; }),
          selectedOption: vals[f.key] || profiles[0],
          onChange: function (o) { setField(f.key, o.data); }
        }));
      }
      return h(PanelSectionRow, { key: f.key }, h(TextRow, {
        label: f.label, value: vals[f.key], onChange: function (val) { setField(f.key, val); }
      }));
    });

    // require profile selection for pcsx2 (default to first); validity check
    var valid = true;
    if (type === 'pcsx2_profile') valid = profiles.length > 0;

    return h(Fragment, null,
      h(PanelSectionRow, null, h(DropdownItem, {
        label: 'Add task',
        rgOptions: TASK_DEFS.map(function (d) { return { data: d.type, label: d.label }; }),
        selectedOption: type,
        onChange: function (o) { setType(o.data); setVals({}); }
      })),
      fieldEls,
      h(PanelSectionRow, null, h(ButtonItem, {
        layout: 'below', disabled: props.busy || !valid,
        onClick: function () {
          // pcsx2 profile: ensure the (defaulted) first profile is captured
          if (type === 'pcsx2_profile' && !vals.profile && profiles.length) vals.profile = profiles[0];
          add();
        }
      }, '+ Add task')));
  }

  function Content() {
    var s = useState(null); var state = s[0]; var setState = s[1];
    var b = useState(false); var busy = b[0]; var setBusy = b[1];
    var m = useState(''); var msg = m[0]; var setMsg = m[1];
    var e = useState(false); var editing = e[0]; var setEditing = e[1];
    var c = useState(null); var cfg = c[0]; var setCfg = c[1];
    var d = useState(false); var dirty = d[0]; var setDirty = d[1];

    function refresh() {
      return call('get_state', {}).then(setState).catch(function (err) {
        setState({ error: String(err && err.message ? err.message : err) });
      });
    }
    useEffect(function () {
      refresh();
      var iv = setInterval(function () { if (!editing) refresh(); }, 4000);
      return function () { clearInterval(iv); };
    }, [editing]);

    function doCall(method, args, label) {
      setBusy(true); setMsg(label + '…');
      call(method, args).then(function (r) {
        setBusy(false);
        var text = summarize(r && r.result);
        setMsg(text); toast(text);
        if (r && r.state) setState(r.state); else refresh();
      }).catch(function (err) {
        setBusy(false);
        var text = 'Error: ' + (err && err.message ? err.message : err);
        setMsg(text); toast(text);
      });
    }

    function toggleAuto(v) {
      setBusy(true);
      call('set_auto_dock', { enabled: v }).then(function (r) {
        setBusy(false);
        if (r && r.state) setState(r.state); else refresh();
        setMsg('Auto Dock Detection ' + (v ? 'ON' : 'OFF'));
      }).catch(function (err) { setBusy(false); setMsg('Error: ' + err); });
    }

    // ---- editor plumbing ----
    function enterEdit() {
      setBusy(true);
      call('get_config', {}).then(function (r) {
        setBusy(false);
        setCfg(r && r.config ? r.config : null);
        setDirty(false); setEditing(true);
      }).catch(function (err) { setBusy(false); setMsg('Error: ' + err); });
    }
    function mutate(fn) {
      var next = clone(cfg || {});
      next.actions = next.actions || {}; next.modes = next.modes || {};
      next.settings = next.settings || {};
      fn(next);
      setCfg(next); setDirty(true);
    }
    function saveCfg() {
      if (!cfg) return;
      setBusy(true); setMsg('Saving…');
      call('save_config', { config: cfg }).then(function (r) {
        setBusy(false);
        if (r && r.ok) {
          setDirty(false);
          if (r.state) setState(r.state); else refresh();
          setMsg('Saved'); toast('Configuration saved');
        } else {
          setMsg('Save failed: ' + (r && r.error)); toast('Save failed');
        }
      }).catch(function (err) { setBusy(false); setMsg('Error: ' + err); });
    }
    function exitEdit() {
      setEditing(false); setCfg(null); setDirty(false); refresh();
    }

    if (!state) {
      return h(PanelSection, { title: 'Docky' },
        h(PanelSectionRow, null, h('div', null, 'Loading…')));
    }
    if (state.error) {
      return h(PanelSection, { title: 'Docky' },
        h(PanelSectionRow, null, h('div', { style: { color: 'orange' } }, state.error)),
        h(PanelSectionRow, null, h(ButtonItem, { layout: 'below', onClick: refresh }, 'Retry')));
    }

    var sett = state.settings || {};
    var modes = state.modes || [];
    var actions = state.actions || [];

    // ===== STATUS =====
    var statusSection = h(PanelSection, { title: 'Docky' },
      h(PanelSectionRow, null, h(Field, { label: 'Environment', bottomSeparator: 'thick' },
        state.docked ? 'Docked (external display)' : 'Handheld')),
      h(PanelSectionRow, null, h(Field, { label: 'Active mode', bottomSeparator: 'thick' },
        (function () {
          var am = state.activeMode;
          var found = modes.filter(function (x) { return x.id === am; })[0];
          return found ? found.name : (am || 'none');
        })())),
      h(PanelSectionRow, null, h(ToggleField, {
        label: 'Auto Dock Detection',
        description: 'Auto-switch modes when you dock/undock',
        checked: !!sett.autoDockDetection, disabled: busy, onChange: toggleAuto
      })),
      h(PanelSectionRow, null, h(ButtonItem, {
        layout: 'below', disabled: busy,
        onClick: function () { if (editing) exitEdit(); else enterEdit(); }
      }, editing ? 'Close editor' : 'Edit configuration…')));

    if (!editing) {
      // ===== RUN UI =====
      var modeRows = modes.map(function (mode) {
        var isActive = (mode.id === state.activeMode);
        var isSugg = (mode.id === state.suggestedMode) && !isActive;
        var desc = isActive ? 'Active' : (isSugg ? 'Suggested for this environment' : null);
        return h(PanelSectionRow, { key: 'm_' + mode.id }, h(ButtonItem, {
          layout: 'below', disabled: busy, description: desc,
          onClick: function () { doCall('activate_mode', { mode_id: mode.id }, 'Switching to ' + mode.name); }
        }, (isActive ? '✓ ' : '') + mode.name));
      });
      var modesSection = h(PanelSection, { title: 'Modes' }, modeRows.length ? modeRows
        : h(PanelSectionRow, null, h('div', { style: { opacity: 0.7 } }, 'No modes defined')));

      var actionRows = actions.map(function (a) {
        return h(PanelSectionRow, { key: 'a_' + a.id }, h(ButtonItem, {
          layout: 'below', disabled: busy,
          description: a.taskCount + ' task' + (a.taskCount === 1 ? '' : 's'),
          onClick: function () { doCall('run_action', { action_id: a.id }, 'Running ' + a.name); }
        }, 'Run: ' + a.name));
      });
      var actionsSection = h(PanelSection, { title: 'Run Action' }, actionRows.length ? actionRows
        : h(PanelSectionRow, null, h('div', { style: { opacity: 0.7 } }, 'No actions defined')));

      var footRows = [];
      if (msg) footRows.push(h(PanelSectionRow, { key: 'msg' },
        h('div', { style: { fontSize: '0.75em', opacity: 0.8, padding: '0 16px' } }, msg)));
      footRows.push(h(PanelSectionRow, { key: 'refresh' },
        h(ButtonItem, { layout: 'below', disabled: busy, onClick: refresh }, 'Refresh')));
      var footer = h(PanelSection, null, footRows);

      return h(Fragment, null, statusSection, modesSection, actionsSection, footer);
    }

    // ===== EDITOR =====
    if (!cfg) {
      return h(Fragment, null, statusSection,
        h(PanelSection, null, h(PanelSectionRow, null, h('div', null, 'Loading config…'))));
    }

    var profiles = state.pcsx2_profiles || [];
    var cfgActions = cfg.actions || {};
    var cfgModes = cfg.modes || {};
    var actionIds = Object.keys(cfgActions);
    var modeIds = Object.keys(cfgModes);

    // --- save/revert bar ---
    var saveBar = h(PanelSection, { title: 'Editing' },
      h(PanelSectionRow, null, h('div', { style: { fontSize: '0.75em', opacity: 0.8, padding: '0 16px' } },
        dirty ? 'Unsaved changes' : 'Saved · changes apply on Save')),
      h(PanelSectionRow, null, h(ButtonItem, {
        layout: 'below', disabled: busy || !dirty, onClick: saveCfg
      }, 'Save changes')),
      h(PanelSectionRow, null, h(ButtonItem, {
        layout: 'below', disabled: busy, onClick: enterEdit
      }, dirty ? 'Discard changes' : 'Reload from file')));

    // --- Actions editor ---
    var actionEls = actionIds.map(function (aid) {
      var action = cfgActions[aid];
      var taskEls = (action.tasks || []).map(function (task, ti) {
        return h(PanelSectionRow, { key: 'task_' + ti },
          h(Field, { label: summarizeTask(task), childrenLayout: 'below', bottomSeparator: 'none' },
            h(ButtonItem, { layout: 'below', disabled: busy, onClick: function () {
              mutate(function (n) { n.actions[aid].tasks.splice(ti, 1); });
            } }, 'Remove task')));
      });
      return h(PanelSection, { title: 'Action: ' + (action.name || aid), key: 'act_' + aid },
        h(PanelSectionRow, null, h(TextRow, {
          label: 'Name', value: action.name,
          onChange: function (val) { mutate(function (n) { n.actions[aid].name = val; }); }
        })),
        taskEls.length ? taskEls
          : h(PanelSectionRow, null, h('div', { style: { opacity: 0.7, padding: '0 16px' } }, 'No tasks yet')),
        h(AddTask, {
          profiles: profiles, busy: busy,
          onAdd: function (task) { mutate(function (n) {
            n.actions[aid].tasks = n.actions[aid].tasks || []; n.actions[aid].tasks.push(task);
          }); }
        }),
        h(PanelSectionRow, null, h(ButtonItem, {
          layout: 'below', disabled: busy, onClick: function () {
            mutate(function (n) {
              delete n.actions[aid];
              // drop references from modes
              Object.keys(n.modes).forEach(function (mid) {
                n.modes[mid].actions = (n.modes[mid].actions || []).filter(function (x) { return x !== aid; });
              });
            });
          }
        }, 'Delete action')));
    });

    var newActionSection = h(NewItem, {
      title: 'New action', placeholder: 'Action name', busy: busy,
      onCreate: function (name) {
        mutate(function (n) {
          var id = uniqueId(slugify(name), n.actions);
          n.actions[id] = { name: name, tasks: [] };
        });
      }
    });

    // --- Modes editor ---
    var modeEls = modeIds.map(function (mid) {
      var mode = cfgModes[mid];
      var inMode = mode.actions || [];
      var toggles = actionIds.map(function (aid) {
        return h(PanelSectionRow, { key: 'mt_' + aid }, h(ToggleField, {
          label: cfgActions[aid].name || aid,
          checked: inMode.indexOf(aid) !== -1, disabled: busy,
          onChange: function (on) { mutate(function (n) {
            var arr = n.modes[mid].actions = n.modes[mid].actions || [];
            var idx = arr.indexOf(aid);
            if (on && idx === -1) arr.push(aid);
            if (!on && idx !== -1) arr.splice(idx, 1);
          }); }
        }));
      });
      return h(PanelSection, { title: 'Mode: ' + (mode.name || mid), key: 'mode_' + mid },
        h(PanelSectionRow, null, h(TextRow, {
          label: 'Name', value: mode.name,
          onChange: function (val) { mutate(function (n) { n.modes[mid].name = val; }); }
        })),
        h(PanelSectionRow, null, h('div', { style: { fontSize: '0.75em', opacity: 0.7, padding: '0 16px' } },
          'Actions run in this mode:')),
        toggles.length ? toggles
          : h(PanelSectionRow, null, h('div', { style: { opacity: 0.7, padding: '0 16px' } }, 'No actions to assign')),
        h(PanelSectionRow, null, h(ButtonItem, {
          layout: 'below', disabled: busy, onClick: function () {
            mutate(function (n) {
              delete n.modes[mid];
              if (n.settings.dockedMode === mid) n.settings.dockedMode = '';
              if (n.settings.undockedMode === mid) n.settings.undockedMode = '';
            });
          }
        }, 'Delete mode')));
    });

    var newModeSection = h(NewItem, {
      title: 'New mode', placeholder: 'Mode name', busy: busy,
      onCreate: function (name) {
        mutate(function (n) {
          var id = uniqueId(slugify(name), n.modes);
          n.modes[id] = { name: name, actions: [] };
        });
      }
    });

    // --- Dock mapping + poll ---
    var modeOpts = [{ data: '', label: '(none)' }].concat(modeIds.map(function (mid) {
      return { data: mid, label: cfgModes[mid].name || mid };
    }));
    var settingsSection = h(PanelSection, { title: 'Auto-dock mapping' },
      h(PanelSectionRow, null, h(DropdownItem, {
        label: 'When docked → mode',
        rgOptions: modeOpts, selectedOption: cfg.settings.dockedMode || '',
        onChange: function (o) { mutate(function (n) { n.settings.dockedMode = o.data; }); }
      })),
      h(PanelSectionRow, null, h(DropdownItem, {
        label: 'When undocked → mode',
        rgOptions: modeOpts, selectedOption: cfg.settings.undockedMode || '',
        onChange: function (o) { mutate(function (n) { n.settings.undockedMode = o.data; }); }
      })),
      h(PanelSectionRow, null, h(TextRow, {
        label: 'Dock poll interval (seconds)', value: String(cfg.settings.pollSeconds || 3),
        onChange: function (val) { mutate(function (n) {
          var num = parseInt(val, 10); n.settings.pollSeconds = (isNaN(num) || num < 1) ? 1 : num;
        }); }
      })));

    return h(Fragment, null, statusSection, saveBar,
      h(PanelSection, { title: 'Actions' }, h(PanelSectionRow, null,
        h('div', { style: { fontSize: '0.75em', opacity: 0.7, padding: '0 16px' } },
          'An action is an ordered list of tasks.'))),
      actionEls, newActionSection,
      h(PanelSection, { title: 'Modes' }, h(PanelSectionRow, null,
        h('div', { style: { fontSize: '0.75em', opacity: 0.7, padding: '0 16px' } },
          'A mode runs a set of actions (manually or on dock/undock).'))),
      modeEls, newModeSection,
      settingsSection,
      h(PanelSection, null, msg ? h(PanelSectionRow, null,
        h('div', { style: { fontSize: '0.75em', opacity: 0.8, padding: '0 16px' } }, msg)) : null));
  }

  // New-action / new-mode creator with its own text-input state.
  function NewItem(props) {
    var n = useState(''); var name = n[0]; var setName = n[1];
    return h(PanelSection, { title: props.title },
      h(PanelSectionRow, null, h(TextRow, {
        label: 'Name', value: name, onChange: setName
      })),
      h(PanelSectionRow, null, h(ButtonItem, {
        layout: 'below', disabled: props.busy || !name.trim(),
        onClick: function () { props.onCreate(name.trim()); setName(''); }
      }, '+ Create')));
  }

  var index = deckyFrontendLib.definePlugin(function (serverApi) {
    server = serverApi;
    return {
      title: h('div', { className: 'Title' }, 'Docky'),
      content: h(Content, null),
      icon: h(DockIcon, null),
      onDismount: function () { }
    };
  });

  return index;

})(SP_REACT, DFL);
