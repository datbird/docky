"""
Docky engine — config-driven automation for the Steam Deck.

Model:
  Task   - one atomic operation (file op / run script / built-in like pcsx2_profile)
  Action - an ordered list of tasks
  Mode   - a named set of actions, activated manually or by auto-dock detection

Config lives at ~/.config/docky/config.json (human-editable).
Small runtime state (active mode, last dock state) at ~/.config/docky/state.json.

No decky deps -> importable/testable with plain python3.
"""

import os
import json
import shutil
import subprocess
import tempfile
import time
import glob

import padswap  # proven PCSX2 input-profile logic
import sunshine  # Docky's own Sunshine flatpak control

CONFIG_DIR = os.path.expanduser("~/.config/docky")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
STATE_PATH = os.path.join(CONFIG_DIR, "state.json")

DEFAULT_TIMEOUT = 60

# Built-in task type registry is implemented in run_task() below.
TASK_TYPES = ["pcsx2_profile", "copy", "move", "symlink", "write",
              "delete", "bash", "python", "run"]


# ---------------- config / state ----------------

def default_config():
    # Start empty — no example actions/modes. The user builds their own via the
    # editor; the add-task picker defaults to the pcsx2_profile task type.
    return {
        "version": 1,
        "settings": {
            "autoDockDetection": False,
            "dockedMode": "",
            "undockedMode": "",
            "pollSeconds": 3,
            # Dock-detection signals. Default: require an external display.
            # Uncheck requireExternalDisplay to fall back to dock-presence
            # signals (each enabled one is required / AND-ed).
            "requireExternalDisplay": True,
            "requireAcPower": False,
            "requireUsbHub": False,
            # Launch Sunshine when the plugin loads (i.e. at boot), so streaming
            # is available after a reboot without opening the panel.
            "autostartSunshine": True,
        },
        "actions": {},
        "modes": {},
        # Per-task-type settings (global, not per-task), keyed by task type.
        # e.g. {"pcsx2_profile": {"profiles_dir": "..."}}
        "taskSettings": {},
        # Ordered list of pinned actions/modes shown in the panel's Favorites
        # section. Each entry: {"kind": "action"|"mode", "id": "<id>"}.
        "favorites": [],
    }


def _read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return fallback


def load_config():
    cfg = _read_json(CONFIG_PATH, None)
    if cfg is None:
        cfg = default_config()
        save_config(cfg)
    # tolerate partial configs
    base = default_config()
    for k, v in base.items():
        cfg.setdefault(k, v)
    for k, v in base["settings"].items():
        cfg["settings"].setdefault(k, v)
    # Sync padswap to the configured PCSX2 profiles folder (if overridden), so
    # every code path that loads config uses the right install location.
    ts = (cfg.get("taskSettings") or {}).get("pcsx2_profile") or {}
    padswap.configure(ts.get("profiles_dir") or None)
    return cfg


def save_config(cfg):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)
    # Keep the config user-owned/editable even though the backend runs as root.
    _chown_to_parent(CONFIG_DIR)
    _chown_to_parent(CONFIG_PATH)


def load_state():
    return _read_json(STATE_PATH, {"activeMode": None, "lastDock": None})


def save_state(state):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)
    _chown_to_parent(CONFIG_DIR)
    _chown_to_parent(STATE_PATH)


# ---------------- helpers ----------------

def _p(path):
    return os.path.expanduser(os.path.expandvars(path)) if path else path


def _chown_to_parent(path):
    """When running as root, give a freshly created file/link the same owner as
    its parent directory (usually 'deck'), so user-space stays able to read/edit
    it. No-op when not root or on error."""
    try:
        if os.geteuid() != 0:
            return
        parent = os.path.dirname(os.path.abspath(path)) or "."
        st = os.stat(parent)
        os.chown(path, st.st_uid, st.st_gid, follow_symlinks=False)
    except OSError:
        pass




def _run_proc(argv, shell=False, cwd=None, timeout=DEFAULT_TIMEOUT, env=None):
    try:
        cp = subprocess.run(
            argv, shell=shell, cwd=_p(cwd) if cwd else os.path.expanduser("~"),
            capture_output=True, text=True, timeout=timeout,
            env=env or os.environ.copy(),
        )
        out = (cp.stdout or "") + (cp.stderr or "")
        out = out.strip()
        if len(out) > 600:
            out = out[:600] + "…(truncated)"
        ok = cp.returncode == 0
        msg = "exit %d%s" % (cp.returncode, (": " + out) if out else "")
        return ok, msg
    except subprocess.TimeoutExpired:
        return False, "timed out after %ss" % timeout
    except (OSError, ValueError) as e:
        return False, "run error: %s" % e


# ---------------- task execution ----------------

def run_task(task, allow_running_emu=True):
    """Execute one task dict -> {type, ok, skipped, message}."""
    t = task.get("type")
    r = {"type": t, "ok": False, "skipped": False, "message": ""}
    try:
        if t == "pcsx2_profile":
            if not allow_running_emu and padswap.pcsx2_running():
                r.update(ok=True, skipped=True,
                         message="skipped: PCSX2 is running")
                return r
            ok, msg = padswap.apply_profile(task["profile"],
                                            force=bool(task.get("force")))
            r.update(ok=ok, message=msg)

        elif t == "copy":
            src, dest = _p(task["src"]), _p(task["dest"])
            os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
            shutil.copy2(src, dest)
            _chown_to_parent(dest)
            r.update(ok=True, message="copied -> %s" % dest)

        elif t == "move":
            src, dest = _p(task["src"]), _p(task["dest"])
            os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
            shutil.move(src, dest)
            _chown_to_parent(dest)
            r.update(ok=True, message="moved -> %s" % dest)

        elif t == "symlink":
            target, link = _p(task["target"]), _p(task["link"])
            if os.path.islink(link) or os.path.exists(link):
                if task.get("replace", True):
                    if os.path.islink(link) or os.path.isfile(link):
                        os.remove(link)
                    else:
                        r.update(message="link path is a directory; refused")
                        return r
            os.symlink(target, link)
            _chown_to_parent(link)
            r.update(ok=True, message="symlink %s -> %s" % (link, target))

        elif t == "write":
            path = _p(task["path"])
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(task.get("content", ""))
            if task.get("mode"):
                os.chmod(path, int(str(task["mode"]), 8))
            _chown_to_parent(path)
            r.update(ok=True, message="wrote %s" % path)

        elif t == "delete":
            path = _p(task["path"])
            if os.path.islink(path) or os.path.isfile(path):
                os.remove(path)
                r.update(ok=True, message="deleted %s" % path)
            elif os.path.isdir(path) and task.get("recursive"):
                shutil.rmtree(path)
                r.update(ok=True, message="deleted dir %s" % path)
            elif not os.path.exists(path):
                r.update(ok=True, message="already absent: %s" % path)
            else:
                r.update(message="is a directory (set recursive:true): %s" % path)

        elif t in ("bash", "python"):
            interp = ["bash"] if t == "bash" else ["python3"]
            args = [str(a) for a in task.get("args", [])]
            if task.get("path"):
                argv = interp + [_p(task["path"])] + args
                ok, msg = _run_proc(argv, cwd=task.get("cwd"),
                                    timeout=task.get("timeout", DEFAULT_TIMEOUT))
            else:
                argv = interp + ["-c", task.get("script", "")] + args
                ok, msg = _run_proc(argv, cwd=task.get("cwd"),
                                    timeout=task.get("timeout", DEFAULT_TIMEOUT))
            r.update(ok=ok, message=msg)

        elif t == "run":
            if task.get("argv"):
                argv = [_p(task["argv"][0])] + [str(a) for a in task["argv"][1:]]
                ok, msg = _run_proc(argv, shell=False, cwd=task.get("cwd"),
                                    timeout=task.get("timeout", DEFAULT_TIMEOUT))
            else:
                ok, msg = _run_proc(task.get("command", ""), shell=True,
                                    cwd=task.get("cwd"),
                                    timeout=task.get("timeout", DEFAULT_TIMEOUT))
            r.update(ok=ok, message=msg)

        elif t == "sunshine_start":
            ok, msg = sunshine.start()
            r.update(ok=ok, message=msg)

        elif t == "sunshine_stop":
            ok, msg = sunshine.stop()
            r.update(ok=ok, message=msg)

        elif t == "sunshine_restart":
            ok, msg = sunshine.restart()
            r.update(ok=ok, message=msg)

        elif t == "sunshine_composition":
            ok, msg = sunshine.set_composition(bool(task.get("enabled")))
            r.update(ok=ok, message=msg)

        elif t == "sunshine_encoder":
            ok, msg = sunshine.set_encoder(task.get("encoder", ""))
            r.update(ok=ok, message=msg)

        else:
            r.update(message="unknown task type: %r" % t)
    except KeyError as e:
        r.update(message="missing field %s for %s task" % (e, t))
    except Exception as e:  # noqa: BLE001
        r.update(message="%s: %s" % (type(e).__name__, e))
    return r


# ---------------- action / mode runners ----------------

def run_action(action_id, allow_running_emu=True, cfg=None):
    cfg = cfg or load_config()
    action = cfg.get("actions", {}).get(action_id)
    if not action:
        return {"action": action_id, "ok": False, "results": [],
                "message": "no such action"}
    results = []
    ok_all = True
    cont = bool(action.get("continueOnError"))
    for task in action.get("tasks", []):
        res = run_task(task, allow_running_emu=allow_running_emu)
        results.append(res)
        if not res["ok"]:
            ok_all = False
            if not cont:
                break
    return {"action": action_id, "name": action.get("name", action_id),
            "ok": ok_all, "results": results}


def activate_mode(mode_id, allow_running_emu=True, cfg=None, mark_active=True):
    cfg = cfg or load_config()
    mode = cfg.get("modes", {}).get(mode_id)
    if not mode:
        return {"mode": mode_id, "ok": False, "actions": [],
                "message": "no such mode"}
    action_results = []
    ok_all = True
    for aid in mode.get("actions", []):
        ar = run_action(aid, allow_running_emu=allow_running_emu, cfg=cfg)
        action_results.append(ar)
        if not ar["ok"]:
            ok_all = False
    if mark_active:
        st = load_state()
        st["activeMode"] = mode_id
        save_state(st)
    return {"mode": mode_id, "name": mode.get("name", mode_id),
            "ok": ok_all, "actions": action_results}


# ---------------- plugin detection ----------------

def _plugins_dir():
    cand = os.path.join(os.environ["DECKY_HOME"], "plugins") if os.environ.get("DECKY_HOME") else None
    for d in (cand, os.path.expanduser("~/homebrew/plugins")):
        if d and os.path.isdir(d):
            return d
    return os.path.expanduser("~/homebrew/plugins")


def installed_plugins():
    """Folder names of installed Decky plugins, so task types can gate on a
    dependency (e.g. a Sunshine task requiring the decky-sunshine plugin)."""
    try:
        d = _plugins_dir()
        return sorted(n for n in os.listdir(d) if os.path.isdir(os.path.join(d, n)))
    except OSError:
        return []


# ---------------- dock / status ----------------

def is_docked(cfg=None):
    """Decide "docked" from the user's chosen signals.

    By default (requireExternalDisplay) it means an external display is
    connected. Unchecking that switches to dock-presence signals: AC power
    and/or a USB hub. Each enabled sub-signal is *required* (AND), so enabling
    both means "docked only when AC power AND a USB hub are present" — i.e. a
    real dock, not a bare charger. If none are enabled, never docked.
    """
    s = (cfg or load_config()).get("settings", {})
    if s.get("requireExternalDisplay", True):
        return padswap.external_display_connected()
    conds = []
    if s.get("requireAcPower", False):
        conds.append(padswap.ac_present())
    if s.get("requireUsbHub", False):
        conds.append(padswap.usb_hub_present())
    return all(conds) if conds else False


def suggested_mode(cfg=None):
    cfg = cfg or load_config()
    s = cfg["settings"]
    return s["dockedMode"] if is_docked(cfg) else s["undockedMode"]


def _resolved_favorites(cfg):
    """Resolve config favorites into panel-ready entries with names, flagging
    any whose referenced action/mode no longer exists."""
    actions = cfg.get("actions", {})
    modes = cfg.get("modes", {})
    out = []
    for f in cfg.get("favorites") or []:
        if not isinstance(f, dict):
            continue
        kind, fid = f.get("kind"), f.get("id")
        store = actions if kind == "action" else modes if kind == "mode" else None
        if store is None or not fid:
            continue
        item = store.get(fid)
        name = item.get("name", fid) if item else fid
        out.append({"kind": kind, "id": fid, "name": name, "missing": item is None})
    return out


def get_state():
    cfg = load_config()
    st = load_state()
    return {
        "settings": cfg["settings"],
        "docked": is_docked(cfg),
        "suggestedMode": suggested_mode(cfg),
        "activeMode": st.get("activeMode"),
        "modes": [{"id": k, "name": v.get("name", k),
                   "actions": v.get("actions", [])}
                  for k, v in cfg.get("modes", {}).items()],
        "actions": [{"id": k, "name": v.get("name", k),
                     "taskCount": len(v.get("tasks", []))}
                    for k, v in cfg.get("actions", {}).items()],
        "favorites": _resolved_favorites(cfg),
        "pcsx2_profiles": padswap.list_profiles(),
        "pcsx2_running": padswap.pcsx2_running(),
        "installed_plugins": installed_plugins(),
        "sunshine": dict(sunshine.status(), credsStored=bool(st.get("sunshineAuth"))),
        "config_path": CONFIG_PATH,
    }


def autostart_sunshine():
    """Start Sunshine on plugin load if the autostartSunshine setting is on.

    Returns (attempted, ok, message). Safe to call unconditionally — it no-ops
    when the setting is off or Sunshine is already running.
    """
    cfg = load_config()
    if not cfg["settings"].get("autostartSunshine"):
        return False, True, "autostart disabled"
    ok, msg = sunshine.start()
    return True, ok, msg


def sunshine_start():
    """Start the Sunshine engine (no-op if already running)."""
    ok, msg = sunshine.start()
    return {"ok": ok, "message": msg}


def sunshine_stop():
    """Stop the Sunshine engine."""
    ok, msg = sunshine.stop()
    return {"ok": ok, "message": msg}


def sunshine_restart():
    """Restart the Sunshine engine."""
    ok, msg = sunshine.restart()
    return {"ok": ok, "message": msg}


def set_sunshine_login(username, password):
    """Set/reset Sunshine's admin login and remember it for pairing."""
    ok, msg, auth = sunshine.set_login(username, password)
    if ok and auth:
        st = load_state()
        st["sunshineUser"] = username
        st["sunshineAuth"] = auth
        save_state(st)
    return {"ok": ok, "message": msg}


def sunshine_pair(pin, name=""):
    """Complete a Moonlight pairing using the stored Sunshine login."""
    st = load_state()
    ok, msg = sunshine.pair(pin, name, st.get("sunshineAuth"))
    return {"ok": ok, "message": msg}


def sunshine_clients():
    """List currently paired Moonlight clients."""
    st = load_state()
    clients = sunshine.list_clients(st.get("sunshineAuth"))
    return {"ok": clients is not None, "clients": clients or []}


def sunshine_unpair(uuid):
    st = load_state()
    ok, msg = sunshine.unpair(uuid, st.get("sunshineAuth"))
    return {"ok": ok, "message": msg}


def sunshine_unpair_all():
    st = load_state()
    ok, msg = sunshine.unpair_all(st.get("sunshineAuth"))
    return {"ok": ok, "message": msg}


def set_autostart_sunshine(enabled):
    cfg = load_config()
    cfg["settings"]["autostartSunshine"] = bool(enabled)
    save_config(cfg)
    return cfg["settings"]


def set_auto_dock(enabled):
    cfg = load_config()
    cfg["settings"]["autoDockDetection"] = bool(enabled)
    save_config(cfg)
    # baseline current dock state so we only act on the NEXT change
    st = load_state()
    st["lastDock"] = is_docked(cfg)
    save_state(st)
    return cfg["settings"]
