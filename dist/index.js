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

  function DockIcon() {
    return h('svg', { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'currentColor' },
      h('path', { d: 'M4 5h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5v2h2a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h2v-2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v7h16V7H4z' }));
  }

  function summarize(result) {
    if (!result) return 'Done';
    if (result.message) return result.message;
    // mode result -> count task outcomes
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

  function Content() {
    var s = useState(null); var state = s[0]; var setState = s[1];
    var b = useState(false); var busy = b[0]; var setBusy = b[1];
    var m = useState(''); var msg = m[0]; var setMsg = m[1];

    function refresh() {
      return call('get_state', {}).then(setState).catch(function (e) {
        setState({ error: String(e && e.message ? e.message : e) });
      });
    }
    useEffect(function () {
      refresh();
      var iv = setInterval(refresh, 4000); // keep dock state / active mode fresh
      return function () { clearInterval(iv); };
    }, []);

    function doCall(method, args, label) {
      setBusy(true); setMsg(label + '…');
      call(method, args).then(function (r) {
        setBusy(false);
        var text = summarize(r && r.result);
        setMsg(text); toast(text);
        if (r && r.state) setState(r.state); else refresh();
      }).catch(function (e) {
        setBusy(false);
        var text = 'Error: ' + (e && e.message ? e.message : e);
        setMsg(text); toast(text);
      });
    }

    function toggleAuto(v) {
      setBusy(true);
      call('set_auto_dock', { enabled: v }).then(function (r) {
        setBusy(false);
        if (r && r.state) setState(r.state); else refresh();
        setMsg('Auto Dock Detection ' + (v ? 'ON' : 'OFF'));
      }).catch(function (e) { setBusy(false); setMsg('Error: ' + e); });
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

    // --- Status + auto-dock ---
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
        checked: !!sett.autoDockDetection,
        disabled: busy,
        onChange: toggleAuto
      })));

    // --- Modes ---
    var modeRows = modes.map(function (mode) {
      var isActive = (mode.id === state.activeMode);
      var isSugg = (mode.id === state.suggestedMode) && !isActive;
      var desc = isActive ? 'Active' : (isSugg ? 'Suggested for this environment' : null);
      return h(PanelSectionRow, { key: 'm_' + mode.id },
        h(ButtonItem, {
          layout: 'below', disabled: busy, description: desc,
          onClick: function () { doCall('activate_mode', { mode_id: mode.id }, 'Switching to ' + mode.name); }
        }, (isActive ? '✓ ' : '') + mode.name));
    });
    var modesSection = h(PanelSection, { title: 'Modes' }, modeRows.length ? modeRows
      : h(PanelSectionRow, null, h('div', { style: { opacity: 0.7 } }, 'No modes defined')));

    // --- Actions (run standalone) ---
    var actionRows = actions.map(function (a) {
      return h(PanelSectionRow, { key: 'a_' + a.id },
        h(ButtonItem, {
          layout: 'below', disabled: busy,
          description: a.taskCount + ' task' + (a.taskCount === 1 ? '' : 's'),
          onClick: function () { doCall('run_action', { action_id: a.id }, 'Running ' + a.name); }
        }, 'Run: ' + a.name));
    });
    var actionsSection = h(PanelSection, { title: 'Run Action' }, actionRows.length ? actionRows
      : h(PanelSectionRow, null, h('div', { style: { opacity: 0.7 } }, 'No actions defined')));

    // --- Footer ---
    var footRows = [];
    if (msg) footRows.push(h(PanelSectionRow, { key: 'msg' },
      h('div', { style: { fontSize: '0.75em', opacity: 0.8, padding: '0 16px' } }, msg)));
    footRows.push(h(PanelSectionRow, { key: 'cfg' },
      h('div', { style: { fontSize: '0.7em', opacity: 0.55, padding: '0 16px' } },
        'Edit ' + (state.config_path || '~/.config/docky/config.json') + ' (Desktop) to add tasks/actions/modes.')));
    footRows.push(h(PanelSectionRow, { key: 'refresh' },
      h(ButtonItem, { layout: 'below', disabled: busy, onClick: refresh }, 'Refresh')));
    var footer = h(PanelSection, null, footRows);

    return h(Fragment, null, statusSection, modesSection, actionsSection, footer);
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
