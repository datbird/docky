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
import time

import logging
import threading

_log = logging.getLogger("docky")

import padswap  # proven PCSX2 input-profile logic
import sunshine  # Docky's own Sunshine flatpak control
import mdns      # keep avahi publishing on so Moonlight can discover Sunshine
import deckops   # built-in Steam Deck dock fixes (audio/controller/tdp/flatpak)
from sysenv import clean_env as _clean_env  # strip Decky's PyInstaller LD_LIBRARY_PATH

CONFIG_DIR = os.path.expanduser("~/.config/docky")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
STATE_PATH = os.path.join(CONFIG_DIR, "state.json")

DEFAULT_TIMEOUT = 60

# Sentinel for "never set", where None is itself a meaningful value.
_UNSET = object()


# ---------------- config / state ----------------

def default_config():
    # Start empty — no example actions/modes. The user builds their own via the
    # editor; the add-task picker defaults to the pcsx2_profile task type.
    #
    # This MUST stay a function returning fresh objects. load_config() splices
    # these values into the loaded config with setdefault(), so a module-level
    # constant would hand every config the *same* nested dicts/lists — an edit
    # to one config's fanCurve would then show up in the next load.
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
            # Which Sunshine backend Docky's tasks use:
            #   "auto"           — detect: decky-sunshine plugin > installed
            #                      flatpak (integrated) > off (default).
            #   "integrated"     — Docky owns install/autostart/launch.
            #   "decky-sunshine" — defer lifecycle to the decky-sunshine plugin;
            #                      Docky's shared tasks still operate on the same
            #                      Sunshine flatpak (stop/encoder/composition/pair).
            #   "off"            — Docky ignores Sunshine entirely.
            "sunshineEngine": "auto",
            # Launch Sunshine when the plugin loads (i.e. at boot), so streaming
            # is available after a reboot without opening the panel.
            "autostartSunshine": True,
            # Force gamescope full-frame composition (fixes the docked
            # stretched/squeezed capture). The gamescope atom is runtime-only
            # and resets every boot, so Docky persists the preference here and
            # re-applies it on load and on each Sunshine (re)start.
            "forceComposition": False,
            # Keep an integrated (Docky-owned) Sunshine alive: a background
            # watchdog relaunches it if it crashes (e.g. the known
            # session::video segfault). Honors an explicit Stop from the panel.
            "sunshineWatchdog": True,
            # --- additional triggers (each a toggle + its own mode mapping) ---
            # AC power connect/disconnect.
            "autoAcDetection": False,
            "acMode": "",        # on AC connected
            "noAcMode": "",      # on AC disconnected (battery)
            # External controller connect/disconnect.
            "autoControllerDetection": False,
            "controllerConnectMode": "",
            "controllerDisconnectMode": "",
            # Resume from sleep/wake.
            "autoResume": False,
            "resumeMode": "",
            # Startup (when Docky loads at boot).
            "autoStartup": False,
            "startupMode": "",
            # --- fan control (Fantastic-style curve engine) ---
            # fanMode: "auto" (SteamOS owns the fan), "manual" (hold a fixed
            # RPM), or "curve" (temperature -> RPM via fanCurve). A background
            # loop in main.py enforces manual/curve every couple of seconds.
            # fanCurve here is the *active* (live) curve; saved presets live in
            # the top-level "fanProfiles". fanProfile = id of the last applied
            # profile (for display), or "" when set manually.
            "fanMode": "auto",
            "fanManualRpm": 3000,
            "fanCurve": {
                "interpolate": True,
                # Deep copy: list() alone would share deckops' point dicts, so
                # editing a curve point in the UI would rewrite the module-level
                # DEFAULT_FAN_CURVE for the life of the process.
                "points": [dict(p) for p in deckops.DEFAULT_FAN_CURVE],
            },
            "fanProfile": "",
            # --- TDP (power cap) ---
            # tdpWatts is the active/last-applied cap. tdpEnforce, when on, makes
            # a background loop re-apply it every few seconds so Steam's own TDP
            # slider can't override it. tdpProfile = last applied preset id.
            "tdpWatts": 15,
            "tdpEnforce": False,
            "tdpProfile": "",
        },
        "actions": {},
        "modes": {},
        # Saved presets. fanProfiles[id] = {name, mode, manualRpm, curve}.
        # tdpProfiles[id] = {name, watts}. Built in the editor's Fan/TDP tabs;
        # applied by the panel, the fan/tdp tasks, or a mode.
        "fanProfiles": {},
        "tdpProfiles": {},
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
    except FileNotFoundError:
        return fallback
    except (OSError, ValueError) as e:
        # A present-but-unreadable/corrupt file shouldn't be silently discarded.
        _log.warning("could not read %s (%s); using fallback", path, e)
        if os.path.isfile(path):
            try:
                os.replace(path, path + ".corrupt")  # keep it for recovery
            except OSError:
                pass
        return fallback


# padswap only needs re-pointing when the configured profiles dir actually
# changes, but load_config() runs on every fan/TDP tick — so remember the last
# value we pushed rather than re-running a side effect a few times a second.
_padswap_dir = _UNSET


def _sync_padswap(profiles_dir):
    global _padswap_dir
    if profiles_dir != _padswap_dir:
        padswap.configure(profiles_dir)
        _padswap_dir = profiles_dir


def load_config():
    """Read config.json, filling in any missing keys from default_config().

    Deliberately NOT cached: every caller mutates the dict it gets back
    (set_fan_mode, apply_tdp_profile, set_trigger, ...) and get_state() hands
    cfg["settings"] straight to the frontend, so a shared cached object would
    leak half-applied edits between callers. Making it safe would need a
    deepcopy on return, which costs about as much as the page-cached read and
    json.loads it would be replacing."""
    cfg = _read_json(CONFIG_PATH, None)
    if not isinstance(cfg, dict):
        if cfg is not None:  # parsed, but into a list/string/number
            _log.warning("config.json is not an object; regenerating")
        cfg = default_config()
        save_config(cfg)
    # tolerate partial configs
    base = default_config()
    for k, v in base.items():
        cfg.setdefault(k, v)
    if not isinstance(cfg.get("settings"), dict):
        cfg["settings"] = base["settings"]
    for k, v in base["settings"].items():
        cfg["settings"].setdefault(k, v)
    # Sync padswap to the configured PCSX2 profiles folder (if overridden), so
    # every code path that loads config uses the right install location.
    ts = (cfg.get("taskSettings") or {}).get("pcsx2_profile") or {}
    _sync_padswap(ts.get("profiles_dir") or None)
    return cfg


# config.json is read-modify-written by several frontend-triggered paths (panel
# fan/TDP quick controls + the editor's full-config save), all on worker threads
# via asyncio.to_thread. Serialize read→modify→write so a whole-object save can't
# clobber a field another writer just set. Re-entrant so a helper holding the lock
# can still call save_config(). Wrap multi-step updates in `with _config_lock:`.
_config_lock = threading.RLock()

# state.json is read-modify-written by both the trigger watcher and frontend
# calls (some via asyncio.to_thread, i.e. a worker thread). Serialize updates so a
# full-object save can't clobber a field another writer just set (e.g. the watcher
# overwriting an activeMode that a fired trigger just wrote).
_state_lock = threading.Lock()


def _write_json_atomic(path, obj):
    """Durably replace `path` with `obj` as JSON.

    os.replace() makes the *rename* atomic, but without an fsync the file's
    contents may not have reached disk when it happens — a hard power-off (which
    a handheld gets plenty of) can leave a zero-length or truncated config
    behind the new name. Sync the data, then the directory entry. Saves are
    user-initiated, never in a loop, so the cost is irrelevant."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    try:
        dfd = os.open(CONFIG_DIR, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass
    # Keep the config user-owned/editable even though the backend runs as root.
    _chown_to_parent(CONFIG_DIR)
    _chown_to_parent(path)


def save_config(cfg):
    with _config_lock:
        _write_json_atomic(CONFIG_PATH, cfg)


def load_state():
    st = _read_json(STATE_PATH, {})
    return st if isinstance(st, dict) else {}


def save_state(state):
    _write_json_atomic(STATE_PATH, state)


def update_state(**fields):
    """Merge `fields` into state.json atomically under a lock — the safe way to
    change a few keys without clobbering concurrent writers."""
    with _state_lock:
        st = load_state()
        st.update(fields)
        save_state(st)
        return st


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
            env=env or _clean_env(),
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
            elif task.get("command"):
                ok, msg = _run_proc(task["command"], shell=True,
                                    cwd=task.get("cwd"),
                                    timeout=task.get("timeout", DEFAULT_TIMEOUT))
            else:
                ok, msg = False, "run task needs 'argv' or 'command'"
            r.update(ok=ok, message=msg)

        elif t == "sunshine_start":
            ok, msg = _eng_start()
            r.update(ok=ok, message=msg)

        elif t == "sunshine_stop":
            ok, msg = sunshine.stop()
            r.update(ok=ok, message=msg)

        elif t == "sunshine_restart":
            ok, msg = _eng_restart()
            r.update(ok=ok, message=msg)

        elif t == "sunshine_composition":
            ok, msg = sunshine.apply_composition(_task_mode(task))
            r.update(ok=ok, message=msg)

        elif t == "sunshine_hdr":
            ok, msg = sunshine.apply_hdr(_task_mode(task))
            r.update(ok=ok, message=msg)

        elif t == "sunshine_encoder":
            ok, msg = sunshine.set_encoder(task.get("encoder", ""))
            r.update(ok=ok, message=msg)

        elif t == "audio_output":
            ok, msg = deckops.set_audio_output(task.get("target", ""))
            r.update(ok=ok, message=msg)

        elif t == "builtin_controller":
            mode = _task_mode(task)
            if mode == "toggle":
                cur = deckops.builtin_controller_enabled()
                ok, msg = deckops.set_builtin_controller(not cur)
            else:
                ok, msg = deckops.set_builtin_controller(mode == "on")
            r.update(ok=ok, message=msg)

        elif t == "tdp":
            # Prefer a saved profile; fall back to an inline watts value.
            if task.get("profile"):
                res = apply_tdp_profile(task["profile"])
            else:
                res = set_tdp_watts(task.get("watts"))
            r.update(ok=res.get("ok", True), message=res.get("message", ""))

        elif t == "fan":
            # Prefer a saved profile; fall back to an inline mode/rpm.
            if task.get("profile"):
                res = apply_fan_profile(task["profile"])
            else:
                res = set_fan_mode(task.get("mode"), task.get("rpm"))
            r.update(ok=res.get("ok", True), message=res.get("message", ""))

        elif t == "release_control":
            res = release_control()
            r.update(ok=res.get("ok", True), message=res.get("message", ""))

        elif t == "flatpak_update":
            ok, msg = deckops.flatpak_update(task.get("app", ""))
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
        update_state(activeMode=mode_id)
    return {"mode": mode_id, "name": mode.get("name", mode_id),
            "ok": ok_all, "actions": action_results}


# ---------------- plugin detection ----------------

def _plugins_dir():
    cand = os.path.join(os.environ["DECKY_HOME"], "plugins") if os.environ.get("DECKY_HOME") else None
    for d in (cand, os.path.expanduser("~/homebrew/plugins")):
        if d and os.path.isdir(d):
            return d
    return os.path.expanduser("~/homebrew/plugins")


# resolved_engine() defaults to "auto", which means every engine check —
# including two per 2s coexist tick — does a listdir plus an isdir per entry.
# Plugins can be installed at runtime, but not so fast that a few seconds of
# staleness matters.
_PLUGIN_TTL = 30.0
_plugins_lock = threading.Lock()
_plugins_cache = None
_plugins_cache_at = -1e9


def installed_plugins(max_age=_PLUGIN_TTL):
    """Folder names of installed Decky plugins, so task types can gate on a
    dependency (e.g. a Sunshine task requiring the decky-sunshine plugin).
    Cached for `max_age` seconds; pass 0 to force a rescan."""
    global _plugins_cache, _plugins_cache_at
    with _plugins_lock:
        now = time.monotonic()
        if _plugins_cache is not None and (now - _plugins_cache_at) < max_age:
            return list(_plugins_cache)
        try:
            d = _plugins_dir()
            found = sorted(n for n in os.listdir(d)
                           if os.path.isdir(os.path.join(d, n)))
        except OSError:
            found = []
        _plugins_cache = found
        _plugins_cache_at = now
        return list(found)


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


def suggested_mode(cfg=None, docked=None):
    cfg = cfg or load_config()
    s = cfg["settings"]
    if docked is None:
        docked = is_docked(cfg)
    return s["dockedMode"] if docked else s["undockedMode"]


# ---------------- fan control (Fantastic-style curve engine) ----------------

def _settings(cfg=None):
    """The settings block. (Was _fan_settings, but TDP and everything else use
    it too — the name was lying.)"""
    return (cfg or load_config()).get("settings", {})


def _fan_target_for(s):
    """The RPM the current fan settings want right now, plus the temp used.
    Returns (mode, target_rpm_or_None, temp_c). target is None in auto mode."""
    mode = s.get("fanMode", "auto")
    temp = deckops.read_temp_c()
    if mode == "manual":
        try:
            return mode, max(0, int(s.get("fanManualRpm") or 0)), temp
        except (TypeError, ValueError):
            return mode, 0, temp
    if mode == "curve":
        fc = s.get("fanCurve") or {}
        return mode, deckops.curve_rpm(temp, fc.get("points") or [],
                                       fc.get("interpolate", True)), temp
    return mode, None, temp


def fan_apply(cfg=None, ensure_stopped=True):
    """Enforce the configured fan mode once (called every tick by the loop while
    in manual/curve). Writes fan1_target for manual/curve; no-op for auto.
    `ensure_stopped=False` skips the per-tick daemon probe on steady-state ticks.
    Returns {mode, owned, target, temp, ok, message}."""
    s = _settings(cfg)
    mode, target, temp = _fan_target_for(s)
    if mode in ("manual", "curve") and target is not None:
        ok, msg = deckops.write_fan_rpm(target, stop_daemon=ensure_stopped)
        return {"mode": mode, "owned": True, "target": target, "temp": temp,
                "ok": ok, "message": msg}
    return {"mode": mode, "owned": False, "target": None, "temp": temp,
            "ok": True, "message": "auto"}


def fan_release():
    """Hand the fan back to SteamOS. Called when leaving manual/curve."""
    return deckops.restore_auto_fan()


def _apply_or_release_fan(cfg):
    """Apply the fan settings in `cfg` (or hand the fan back if they say auto).
    Call OUTSIDE _config_lock — this can spend seconds in `systemctl`."""
    if cfg["settings"].get("fanMode", "auto") == "auto":
        return fan_release()
    res = fan_apply(cfg)
    return res["ok"], res["message"]


def set_fan_mode(mode, rpm=None):
    """Persist a new fan mode (and optional manual RPM) and apply it immediately.
    Used by the `fan` task and the panel's quick controls. The background loop
    then maintains it. Returns {ok, message, state-ish fan dict}."""
    mode = (mode or "auto").lower()
    if mode not in ("auto", "manual", "curve"):
        return {"ok": False, "message": "fan mode must be auto/manual/curve"}
    if rpm is not None and str(rpm) != "":
        try:
            rpm = max(0, int(rpm))
        except (TypeError, ValueError):
            return {"ok": False, "message": "invalid fan RPM: %r" % (rpm,)}
    else:
        rpm = None
    with _config_lock:
        cfg = load_config()
        cfg["settings"]["fanMode"] = mode
        # A manual change isn't a saved profile any more — clear the active marker.
        cfg["settings"]["fanProfile"] = ""
        if rpm is not None:
            cfg["settings"]["fanManualRpm"] = rpm
        save_config(cfg)
    ok, msg = _apply_or_release_fan(cfg)
    return {"ok": ok, "message": msg, "fan": fan_status(cfg)}


def apply_fan_profile(profile_id):
    """Load a saved fan profile into the active fan settings and apply it.
    profile_id "" / "auto" returns the fan to SteamOS. Returns {ok, message, fan}."""
    if not profile_id or profile_id == "auto":
        return set_fan_mode("auto")
    with _config_lock:
        cfg = load_config()
        prof = (cfg.get("fanProfiles") or {}).get(profile_id)
        if not prof:
            return {"ok": False, "message": "no such fan profile: %s" % profile_id}
        s = cfg["settings"]
        s["fanMode"] = prof.get("mode", "curve")
        if "manualRpm" in prof:
            s["fanManualRpm"] = prof["manualRpm"]
        if "curve" in prof:
            s["fanCurve"] = prof["curve"]
        s["fanProfile"] = profile_id
        save_config(cfg)
    ok, msg = _apply_or_release_fan(cfg)
    if ok:
        msg = "applied fan profile '%s'" % prof.get("name", profile_id)
    return {"ok": ok, "message": msg, "fan": fan_status(cfg)}


def fan_status(cfg=None):
    """Live fan state for the UI: mode, current temp/RPM, commanded target, and
    the curve settings."""
    s = _settings(cfg)
    fc = s.get("fanCurve") or {}
    return {
        "mode": s.get("fanMode", "auto"),
        "tempC": deckops.read_temp_c(),
        "rpm": deckops.read_fan_rpm(),
        "target": deckops.read_fan_target(),
        "manualRpm": s.get("fanManualRpm", 0),
        "interpolate": fc.get("interpolate", True),
        "points": fc.get("points") or [],
        # TODO: deckops should expose a public fan_available(); this reaches
        # through a private to answer "is there a fan we can drive?".
        "available": deckops._fan_target_path() is not None,
        "maxRpm": deckops.FAN_MAX_RPM,
        "profile": s.get("fanProfile", ""),
    }


# ---------------- TDP (power cap) ----------------

def set_tdp_watts(watts, mark_manual=True):
    """Apply a TDP cap now and persist it as the active value. mark_manual clears
    the active-profile marker (a hand-set watts isn't a saved profile)."""
    ok, msg = deckops.set_tdp(watts)
    cfg = None
    if ok:
        with _config_lock:
            cfg = load_config()
            cfg["settings"]["tdpWatts"] = max(1, int(watts))  # set_tdp already validated
            if mark_manual:
                cfg["settings"]["tdpProfile"] = ""
            save_config(cfg)
    return {"ok": ok, "message": msg, "tdp": tdp_status(cfg)}


def apply_tdp_profile(profile_id):
    """Apply a saved TDP profile (its watts) and mark it active."""
    with _config_lock:
        cfg = load_config()
        prof = (cfg.get("tdpProfiles") or {}).get(profile_id)
        if not prof:
            return {"ok": False, "message": "no such TDP profile: %s" % profile_id}
        watts = prof.get("watts")
        ok, msg = deckops.set_tdp(watts)  # fast sysfs write; validates + clamps
        if ok:
            cfg["settings"]["tdpWatts"] = int(watts)  # store the validated value
            cfg["settings"]["tdpProfile"] = profile_id
            save_config(cfg)
    if ok:
        msg = "applied TDP profile '%s'" % prof.get("name", profile_id)
    return {"ok": ok, "message": msg, "tdp": tdp_status(cfg)}


def set_tdp_enforce(on):
    """Toggle background TDP enforcement. Turning it on re-applies now so it takes
    effect immediately; the loop keeps it pinned."""
    with _config_lock:
        cfg = load_config()
        cfg["settings"]["tdpEnforce"] = bool(on)
        save_config(cfg)
    if on:
        deckops.set_tdp(cfg["settings"].get("tdpWatts", 15))
    return {"ok": True, "message": "TDP enforcement " + ("on" if on else "off"),
            "tdp": tdp_status(cfg)}


def tdp_apply(cfg=None):
    """Re-apply the active TDP cap (called by the loop while enforcement is on)."""
    return deckops.set_tdp(_settings(cfg).get("tdpWatts", 15))


def release_control():
    """Disable all Docky hardware control: hand the fan back to SteamOS and lift
    the TDP cap to its default (enforcement off). Returns {ok, message, fan, tdp}.

    Note the two separate critical sections: set_fan_mode() takes _config_lock
    on its own, and it calls `systemctl restart` (seconds), so we deliberately
    don't hold the lock across it. A concurrent writer can interleave between
    the fan save and the TDP save; the worst case is a stale marker, not a
    half-released device."""
    fan = set_fan_mode("auto")          # fanMode=auto, fanProfile="", restarts daemon
    with _config_lock:
        cfg = load_config()
        cfg["settings"]["tdpEnforce"] = False
        cfg["settings"]["tdpProfile"] = ""
        save_config(cfg)
    ok_t, msg_t = deckops.reset_tdp()
    ok = bool(fan.get("ok", True)) and ok_t
    return {"ok": ok,
            "message": "Handed Fan & TDP back to SteamOS" if ok else (msg_t or fan.get("message", "")),
            "fan": fan_status(cfg), "tdp": tdp_status(cfg)}


def tdp_status(cfg=None):
    """Live TDP state for the UI."""
    s = _settings(cfg)
    info = deckops.get_tdp()
    return {
        "watts": info.get("watts"),          # current hardware cap
        "setWatts": s.get("tdpWatts", 15),   # configured/last-applied
        "max": info.get("max"),              # None when there's no cap at all
        "enforce": bool(s.get("tdpEnforce", False)),
        "profile": s.get("tdpProfile", ""),
        "available": bool(info),
    }


# ---------------- stateful-task status ----------------

# Task types that expose a readable on/off state (a live status LED on their
# buttons, and an On/Off/Toggle verb). Add a type here plus a reader in
# _task_bool_status to give it both.
_STATEFUL_TASKS = ("sunshine_composition", "sunshine_hdr", "builtin_controller")


def _task_bool_status(task, memo=None):
    """Current on/off state of a stateful task, or None if it has no readable
    state.

    `memo` is a per-get_state() dict keyed by task type. Without it, every
    favorite pinning a composition/HDR task re-reads the same gamescope atom —
    an xprop subprocess apiece — on every UI poll, all to ask an identical
    question with an identical answer."""
    t = task.get("type")
    if t not in _STATEFUL_TASKS:
        return None
    if memo is not None and t in memo:
        return memo[t]
    if t == "sunshine_composition":
        v = sunshine.get_composition()
    elif t == "sunshine_hdr":
        v = sunshine.get_hdr()
    else:
        v = deckops.builtin_controller_enabled()
    if memo is not None:
        memo[t] = v
    return v


def _task_mode(task):
    """on/off/toggle for a stateful task. New tasks carry `mode`; older ones had a
    boolean `enabled` — fall back to that for backward compatibility."""
    return task.get("mode") or ("on" if task.get("enabled") else "off")


def _task_verb(task):
    """Verb describing what a stateful task does, for its button label
    ("On"/"Off"/"Toggle"), or None for non-stateful tasks."""
    if task.get("type") not in _STATEFUL_TASKS:
        return None
    return {"on": "On", "off": "Off", "toggle": "Toggle"}.get(_task_mode(task), "Toggle")


def _action_control(action, memo=None):
    """For an action's first stateful task: its live on/off status and the verb
    it performs. {status: None, verb: None} when nothing stateful."""
    for task in action.get("tasks", []):
        s = _task_bool_status(task, memo)
        if s is not None:
            return {"status": bool(s), "verb": _task_verb(task)}
    return {"status": None, "verb": None}


def _resolved_favorites(cfg):
    """Resolve config favorites into panel-ready entries with names, flagging
    any whose referenced action/mode no longer exists. Action favorites also
    carry a live on/off `status` when their action has a stateful task."""
    actions = cfg.get("actions", {})
    modes = cfg.get("modes", {})
    memo = {}  # one hardware probe per task type per call, not per favorite
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
        ctrl = (_action_control(item, memo) if (item and kind == "action")
                else {"status": None, "verb": None})
        out.append({"kind": kind, "id": fid, "name": name, "missing": item is None,
                    "status": ctrl["status"], "verb": ctrl["verb"]})
    return out


def get_state():
    cfg = load_config()
    st = load_state()
    docked = is_docked(cfg)  # compute once; reuse for suggestedMode
    plugins = installed_plugins()
    return {
        "settings": cfg["settings"],
        "docked": docked,
        "suggestedMode": suggested_mode(cfg, docked),
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
        "installed_plugins": plugins,
        "sunshine": dict(sunshine.status(), credsStored=bool(st.get("sunshineAuth")),
                         engine=sunshine_engine(cfg),
                         resolvedEngine=resolved_engine(cfg, plugins),
                         forceComposition=bool((cfg.get("settings") or {}).get("forceComposition")),
                         watchdog=bool((cfg.get("settings") or {}).get("sunshineWatchdog"))),
        "fan": fan_status(cfg),
        "tdp": tdp_status(cfg),
        "fanProfiles": [{"id": k, "name": v.get("name", k)}
                        for k, v in (cfg.get("fanProfiles") or {}).items()],
        "tdpProfiles": [{"id": k, "name": v.get("name", k), "watts": v.get("watts")}
                        for k, v in (cfg.get("tdpProfiles") or {}).items()],
        "config_path": CONFIG_PATH,
    }


DECKY_SUNSHINE = "decky-sunshine"

# Whether the user explicitly stopped Sunshine from the panel. The watchdog
# won't relaunch a Sunshine the user deliberately stopped; a Start/Restart
# clears it. Runtime-only (resets on plugin reload/boot, where autostart
# governs the initial state instead).
_sunshine_user_stopped = False

# --- Capture-health heal state (module-level; resets on plugin reload/boot) ---
# Guards ensure_capture_healthy() against thrash when it heals the "running but
# capture is dead" (Error 503) state. Mutated from the periodic watcher AND from
# the resume hook — different threads — so the cooldown's read-then-write is a
# real race: both could pass cooldown_ok and both restart Sunshine, which is
# exactly what the cooldown exists to prevent. _capture_lock is taken
# non-blockingly by both entry points: if a heal is already in flight, there is
# by definition nothing for the second caller to do.
_capture_lock = threading.Lock()
_capture_unhealthy_streak = 0   # consecutive definitive-unhealthy reads (debounce)
_capture_failed_heals = 0       # consecutive heal restarts that didn't stick (cap)
_capture_last_heal = -1e9       # monotonic time of the last heal restart (cooldown)
_last_active_outputs = None     # last seen display topology (dock/undock detector)

_CAPTURE_DEBOUNCE = 2           # consecutive bad reads required before acting
_CAPTURE_COOLDOWN = 45.0        # min seconds between capture-heal restarts
_CAPTURE_MAX_FAILED_HEALS = 3   # stop restarting after this many that don't fix it


def sunshine_engine(cfg=None):
    """The raw sunshineEngine setting ('auto' by default)."""
    eng = _settings(cfg).get("sunshineEngine")
    return eng if eng in ("auto", "integrated", DECKY_SUNSHINE, "off") else "auto"


def resolved_engine(cfg=None, plugins=None):
    """The engine actually in effect. 'auto' detects: the decky-sunshine plugin
    wins; else an installed Sunshine flatpak means integrated; else 'off'."""
    eng = sunshine_engine(cfg)
    if eng != "auto":
        return eng
    if DECKY_SUNSHINE in (plugins if plugins is not None else installed_plugins()):
        return DECKY_SUNSHINE
    if sunshine.is_installed():
        return "integrated"
    return "off"


def _eng_start():
    """Start Sunshine via the resolved engine. decky-sunshine: verify the shared
    flatpak is up (it owns launching). off: nudge the user to set it up."""
    eng = resolved_engine()
    if eng == "off":
        return False, "Sunshine isn't set up — install it in Settings → Sunshine"
    if eng == DECKY_SUNSHINE:
        if sunshine.is_running():
            return True, "Sunshine running (managed by decky-sunshine)"
        return False, "Sunshine isn't running — start it from decky-sunshine"
    return sunshine.start()  # integrated; start() itself prompts if not installed


def _eng_restart():
    eng = resolved_engine()
    if eng == "off":
        return False, "Sunshine isn't set up"
    if eng == DECKY_SUNSHINE:
        ok, msg = sunshine.stop()
        return ok, (msg + " — relaunch from decky-sunshine") if ok else msg
    return sunshine.restart()


def autostart_sunshine():
    """Start Sunshine on plugin load if integrated + autostart is on.

    Returns (attempted, ok, message). No-ops when the resolved engine isn't
    integrated (off / decky-sunshine), autostart is off, or it's not installed.
    """
    eng = resolved_engine()
    if eng == DECKY_SUNSHINE:
        return False, True, "decky-sunshine manages Sunshine"
    if eng == "off":
        return False, True, "Sunshine integration off"
    if not load_config()["settings"].get("autostartSunshine"):
        return False, True, "autostart disabled"
    if not sunshine.is_installed():
        return False, True, "Sunshine not installed"
    if desktop_session_active() or not in_game_mode():
        return False, True, "not in Game Mode; leaving Sunshine off so KDE Desktop can use the GPU"
    global _sunshine_user_stopped
    ok, msg = sunshine.start()
    if ok:
        _sunshine_user_stopped = False
        apply_persisted_composition()
    return True, ok, msg


def sunshine_install():
    if resolved_engine() == DECKY_SUNSHINE:
        return {"ok": True, "message": "decky-sunshine manages installation",
                "info": sunshine_version_info()}
    ok, msg = sunshine.ensure_installed()
    return {"ok": ok, "message": msg, "info": sunshine_version_info()}


def sunshine_update():
    if resolved_engine() == DECKY_SUNSHINE:
        return {"ok": True, "message": "update via decky-sunshine",
                "info": sunshine_version_info()}
    ok, msg = sunshine.update()
    return {"ok": ok, "message": msg, "info": sunshine_version_info()}


def sunshine_version_info():
    info = sunshine.version_info()
    info["engine"] = sunshine_engine()
    info["resolvedEngine"] = resolved_engine()
    info["deckySunshineInstalled"] = DECKY_SUNSHINE in installed_plugins()
    return info


def sunshine_start():
    global _sunshine_user_stopped
    ok, msg = _eng_start()
    if ok:
        _sunshine_user_stopped = False
        apply_persisted_composition()
    return {"ok": ok, "message": msg}


def sunshine_stop():
    """Stop Sunshine (flatpak kill works for either engine). Marks user intent
    so the watchdog won't immediately relaunch it."""
    global _sunshine_user_stopped
    _sunshine_user_stopped = True
    ok, msg = sunshine.stop()
    return {"ok": ok, "message": msg}


def sunshine_restart():
    global _sunshine_user_stopped
    ok, msg = _eng_restart()
    if ok:
        _sunshine_user_stopped = False
        apply_persisted_composition()
    return {"ok": ok, "message": msg}


def apply_persisted_composition(cfg=None):
    """Re-apply the saved force-composition preference to gamescope's runtime
    atom (which resets every boot/resume). Returns (ok, message)."""
    return sunshine.set_composition(bool(_settings(cfg).get("forceComposition")))


def set_force_composition(enabled):
    """Persist the force-composition preference and apply it live now."""
    enabled = bool(enabled)
    with _config_lock:
        cfg = load_config()
        cfg["settings"]["forceComposition"] = enabled
        save_config(cfg)
    ok, msg = sunshine.set_composition(enabled)
    return {"ok": ok, "message": msg, "forceComposition": enabled}


def drop_legacy_force_hdr():
    """One-time cleanup of the removed `forceHdr` setting.

    Nothing reads the key any more, so a leftover is inert — but a Deck that was
    already latched into HDR when Docky updated would stay that way with no panel
    control left to undo it (the atom only clears on the next reboot). Clear the
    atom once, drop the key, and never touch HDR on load again.
    """
    _MISSING = object()
    with _config_lock:
        cfg = load_config()
        old = cfg.get("settings", {}).pop("forceHdr", _MISSING)
        if old is _MISSING:
            return False  # already clean (fresh install or previous run)
        save_config(cfg)
    was_on = bool(old)
    if was_on and in_game_mode() and sunshine.get_hdr():
        sunshine.set_hdr(False)
    return was_on


def ensure_gamescope_atoms():
    """Self-heal the runtime force-composition gamescope atom to match the
    persisted preference.

    There is deliberately no HDR equivalent: HDR is a per-stream property the
    Moonlight client negotiates, not a host state to latch. Forcing gamescope
    into HDR output regardless of what the client asked for made every SDR
    client look wrong, so the persisted force-HDR preference was removed. The
    ``sunshine_hdr`` task remains for explicit, user-driven switching.

    The atom is runtime-only: it resets to 0 on every reboot (and on
    resume-from-sleep), and setting it needs gamescope's XWayland ``:0``,
    which may not be up yet when the plugin loads on a fresh boot. The one-shot
    boot apply can therefore lose that race and fail silently, leaving a docked
    image stretched even though the setting is remembered — hence the periodic
    heal. Cheap: reads the atom first and only writes when it's actually out of
    sync. No-ops outside Game Mode (Desktop has no gamescope ``:0`` and the
    docked-stretch fix is meaningless there).

    Returns ``None`` when not applicable (not in Game Mode), ``True`` when the
    atom is confirmed in sync (nothing left to heal), or ``False`` when it is
    still out of sync (e.g. ``:0`` not ready yet) so a caller can keep retrying.
    """
    if not in_game_mode():
        return None
    if not bool(_settings().get("forceComposition")):
        return True  # setting off — atom is naturally 0, nothing to heal
    if sunshine.get_composition():
        return True  # already applied
    set_ok, _ = sunshine.set_composition(True)
    # couldn't set / didn't take — :0 likely not ready, let the caller retry
    return bool(set_ok and sunshine.get_composition())


def set_sunshine_watchdog(enabled):
    """Persist whether the watchdog should keep an integrated Sunshine alive."""
    enabled = bool(enabled)
    with _config_lock:
        cfg = load_config()
        cfg["settings"]["sunshineWatchdog"] = enabled
        save_config(cfg)
    return {"ok": True, "watchdog": enabled,
            "message": "watchdog " + ("on" if enabled else "off")}


# --- Sunshine ⇄ KDE Desktop GPU coexistence --------------------------------
# Sunshine's KMS capture holds the GPU's primary DRM node (/dev/dri/card0), which
# blocks KWin from taking DRM master when you switch to Desktop Mode — the desktop
# then bounces straight back to Game Mode. So Docky runs Sunshine ONLY in Game Mode
# and releases the GPU the instant a Plasma session starts launching, so Moonlight
# (Game Mode) and Desktop RDP both just work without the user juggling Sunshine.
#
# The comms below are compared against a process's `comm` (the kernel's 15-char
# name), never its cmdline. That exactness is load-bearing, not incidental: this
# Deck runs a `start-gamescope` process, so a substring or cmdline match would
# see "gamescope" while Game Mode was up and wrongly stop Sunshine out from under
# a live Moonlight stream. Same semantics `pgrep -x` gave us. One definition, so
# a future SteamOS comm rename can't get fixed in only one of the two readers.
_GAMESCOPE_COMMS = frozenset(("gamescope-wl", "gamescope"))
_DESKTOP_COMMS = frozenset(("kwin_wayland", "plasmashell"))

# in_game_mode() and desktop_session_active() get asked up to four times per 2s
# coexist tick (once by the tick, again inside the autorestart check). As four
# `pgrep -x` fork+execs that was ~100ms of process churn every two seconds for
# two yes/no answers. One scan of /proc/*/comm answers every such question at
# once for ~6ms, and a sub-tick TTL collapses the repeats within a tick to a
# single scan. (Measured on a 293-process Deck: 103ms vs 6.3ms, ~16x.)
_PROC_TTL = 0.5
_proc_lock = threading.Lock()
_comm_cache = None
_comm_cache_at = -1e9


def _running_comms():
    """The comm of every running process as a set — or None if /proc couldn't be
    read and there's no cached answer. Cached for _PROC_TTL.

    None means UNKNOWN, not "nothing is running". Callers must not collapse the
    two: an empty set reads as "gamescope is gone", which would stop Sunshine and
    yank the GPU on the strength of a failed syscall."""
    global _comm_cache, _comm_cache_at
    with _proc_lock:
        now = time.monotonic()
        if _comm_cache is not None and (now - _comm_cache_at) < _PROC_TTL:
            return _comm_cache
        comms = set()
        try:
            for entry in os.scandir("/proc"):
                if not entry.name.isdigit():
                    continue
                try:
                    with open("/proc/%s/comm" % entry.name, encoding="utf-8",
                              errors="replace") as f:
                        comms.add(f.read().strip())
                except OSError:
                    continue  # process exited mid-scan; not our problem
        except OSError:
            # Don't refresh _comm_cache_at — retry on the next call. Returns the
            # last good answer, or None (unknown) if we never had one.
            return _comm_cache
        _comm_cache = comms
        _comm_cache_at = now
        return comms


def _comm_running(name):
    """True if a process whose exact comm is `name` is running."""
    comms = _running_comms()
    return bool(comms) and name in comms


def in_game_mode():
    """Game Mode = the gamescope compositor is up.

    UNKNOWN (/proc unreadable) answers True. Every caller of this either stops
    Sunshine when it's False or leaves things alone when it's True, so guessing
    'up' means guessing 'change nothing' — we never free the GPU and kill a
    healthy stream because a syscall failed. Same fail-safe as
    _gamescope_alive(); the START path is gated by stable_game_mode(), which
    refuses on unknown rather than relying on this."""
    comms = _running_comms()
    if comms is None:
        return True
    return bool(comms & _GAMESCOPE_COMMS)


def desktop_session_active():
    """True if a KDE Plasma / KWin desktop session is present (or coming up). This is
    the DEFINITIVE 'we are in Desktop Mode' signal: when it's true Sunshine must stay
    off so KWin keeps the GPU, regardless of any transient gamescope process during
    the session handoff. Never true in Game Mode (no kwin_wayland/plasmashell there).

    UNKNOWN answers False, pairing with in_game_mode()'s True so that an
    unreadable /proc resolves to 'leave everything exactly as it is'."""
    comms = _running_comms()
    if comms is None:
        return False
    return bool(comms & _DESKTOP_COMMS)


# --- fast, uncached gamescope liveness (the sub-second release path) --------
# The pid is stable for a whole Game Mode session, so pin it: the steady-state
# check becomes ONE open() of /proc/<pid>/comm (~21us) instead of a scan that
# short-circuits on first match but still averages half of 293 processes (~3ms).
# At the release watcher's 4Hz that's the difference between ~12ms/sec burned
# forever while nothing is happening and effectively nothing. Recycled pids are a
# non-issue because the comm is re-verified on every read.
#
# The real answer is os.pidfd_open() on this pid + loop.add_reader(): the fd goes
# readable the microsecond gamescope exits, giving ~0 latency and no polling in
# either direction. Worth doing; this is the stopgap that makes the poll cheap.
_gamescope_pid = None

# Once we've confirmed gamescope is gone AND there's nothing left to release,
# stop re-scanning at 4Hz. Sub-second freshness only matters while Sunshine is
# holding card0; with the GPU already freed the only thing left to notice is
# gamescope's RETURN, which the 2s coexist loop owns anyway. Bounded by the 5s
# start debounce: Sunshine cannot hold the card again until gamescope has been
# continuously up for _GAME_MODE_STABLE_SECS, so a window no longer than that
# always re-arms us before there's anything to release. Without this, a Desktop
# session pays the full ~6.3ms scan four times a second for its entire duration.
_GAMESCOPE_GONE_TTL = 5.0
_gamescope_gone_until = 0.0


def _gamescope_alive():
    """Fresh, UNCACHED check for the gamescope compositor.

    The fast GPU-release watcher (sub-second) must see gamescope vanish within
    its poll interval, but _running_comms() caches for _PROC_TTL (0.5s), which
    can hide the transition past the ~0.3-0.5s window the desktop has before it
    reaches for card0. So this reads /proc directly. Same exact-comm semantics as
    in_game_mode().

    On observed absence it also invalidates the comm cache and resets the
    stability clock — see the comment at the bottom of the function."""
    global _gamescope_pid, _game_mode_stable_since, _comm_cache

    pid = _gamescope_pid
    if pid is not None:
        try:
            with open("/proc/%d/comm" % pid, encoding="utf-8",
                      errors="replace") as f:
                if f.read().strip() in _GAMESCOPE_COMMS:
                    return True          # the 99.9% case: one open(), ~21us
        except OSError:
            pass                         # exited, or the pid got recycled
        _gamescope_pid = None

    try:
        for entry in os.scandir("/proc"):
            if not entry.name.isdigit():
                continue
            try:
                with open("/proc/%s/comm" % entry.name, encoding="utf-8",
                          errors="replace") as f:
                    c = f.read().strip()
            except OSError:
                continue  # process exited mid-scan
            if c in _GAMESCOPE_COMMS:
                _gamescope_pid = int(entry.name)
                return True
    except OSError:
        # /proc unreadable: assume Game Mode is up so we DON'T wrongly free the
        # GPU and kill a healthy stream. Same fail-safe as in_game_mode().
        return True

    # Gamescope is definitively gone, and we observed that FIRST-HAND. Two pieces
    # of shared state are now known-wrong and must not be left for the slower
    # loops to read:
    #
    #   _comm_cache — up to 0.5s stale and still saying gamescope is present
    #                 (and kwin absent, since it hasn't spawned yet).
    #   _game_mode_stable_since — set minutes ago, so stable_game_mode() would
    #                 still report "stably up".
    #
    # Leave them and a coexist tick landing inside the TTL window (~25% of
    # transitions, at 0.5s stale vs a 2s loop) reads both, skips its STOP branch,
    # falls through to _autorestart_wanted() — watchdog on, user-stopped false
    # because force_stop deliberately doesn't set it, stable_game_mode() true
    # from cache, not running true because we just killed it — and starts
    # Sunshine roughly 250ms after this tick freed card0. Inside the exact window
    # the desktop needs. That reassembles the 25s bounce out of parts.
    #
    # Resetting the clock is the load-bearing half: it forces a fresh
    # _GAME_MODE_STABLE_SECS of continuous gamescope before Sunshine can return,
    # which is what the debounce was always documented to mean.
    with _proc_lock:
        _comm_cache = None
    _game_mode_stable_since = None
    return False


# Hysteresis for STARTING Sunshine. Stopping is always immediate (free the GPU fast);
# starting waits until Game Mode has been continuously up for a few seconds. Without
# this, a switch-to-Desktop that BOUNCES makes gamescope flicker in and out — it keeps
# trying and failing to grab the GPU because Sunshine still holds it — and each flicker
# read as "in_game_mode" would restart Sunshine mid-handoff, re-grabbing the GPU and
# perpetuating the bounce forever. The debounce lets gamescope (or KWin) win the GPU
# before Sunshine is allowed back.
_game_mode_stable_since = None   # monotonic time gamescope became continuously present
_GAME_MODE_STABLE_SECS = 5.0     # gamescope must be up this long before Sunshine returns


def stable_game_mode():
    """in_game_mode(), debounced and desktop-vetoed — the gate for (re)STARTING
    Sunshine. False whenever a desktop session is present, whenever gamescope is gone,
    or until gamescope has been continuously up for _GAME_MODE_STABLE_SECS.

    Reads one comm snapshot rather than calling in_game_mode() and
    desktop_session_active() separately, so the two halves can't straddle a TTL
    expiry and disagree. Unknown (/proc unreadable) is False: unlike the STOP
    paths, STARTING on a guess is the reverse risk — it would grab card0 back.
    Called from the 2s coexist loop, the 6s keep-alive loop, and (via the clock
    reset in _gamescope_alive) the 0.25s release loop; a benign GIL-safe race on
    the timestamp only delays Sunshine's return by a tick."""
    global _game_mode_stable_since
    comms = _running_comms()
    if (comms is None
            or (comms & _DESKTOP_COMMS)
            or not (comms & _GAMESCOPE_COMMS)):
        _game_mode_stable_since = None
        return False
    now = time.monotonic()
    if _game_mode_stable_since is None:
        _game_mode_stable_since = now
        return False
    return (now - _game_mode_stable_since) >= _GAME_MODE_STABLE_SECS


def sunshine_release_tick():
    """Fast GPU-release check, run on the coexistence watcher's SUB-SECOND loop.

    The instant Game Mode ends (gamescope gone), SIGKILL Sunshine so /dev/dri/card0
    frees for whatever takes the GPU next — the KDE desktop on a switch-to-Desktop,
    or a gamescope relaunch after a crash.

    UNCONDITIONAL on purpose, INCLUDING mid-stream. A Moonlight stream of a Game
    Mode that is ending is over regardless, and Sunshine keeping card0 only
    deadlocks the successor. Proven on-device (2026-07-17): switching to Desktop
    while streaming bounced for ~25s because Sunshine held the GPU and the old
    is_streaming() guard refused to stop it; freeing it within ~50ms let the
    desktop come up cleanly and stay. That is why the release path has no stream
    guard. Sunshine returns via the coexist autostart once Game Mode is stably
    back. Low-level force_stop, so it does NOT set the user-stopped flag.

    Runs sub-second, so BOTH steady states must stay cheap: with Game Mode up the
    pinned-pid check short-circuits in ~21us before any config load or Sunshine
    probe; with Game Mode down and the GPU already freed, _gamescope_gone_until
    parks the loop instead of paying a full /proc scan 4x a second for the length
    of a desktop session. Returns a status string only when it acts."""
    global _gamescope_gone_until
    now = time.monotonic()
    if now < _gamescope_gone_until:
        return None                       # already freed; nothing to release
    if _gamescope_alive():
        _gamescope_gone_until = 0.0       # Game Mode up — re-arm, cheap common case
        return None
    if not sunshine.is_running():
        _gamescope_gone_until = now + _GAMESCOPE_GONE_TTL
        return None                       # nothing holding the GPU
    if resolved_engine() != "integrated" or not sunshine.is_installed():
        _gamescope_gone_until = now + _GAMESCOPE_GONE_TTL
        return None
    ok, _ = sunshine.force_stop()
    if ok:
        _gamescope_gone_until = now + _GAMESCOPE_GONE_TTL
    return "freed GPU — Game Mode ended (Sunshine yielded card0)" if ok else None


def sunshine_coexist_tick():
    """One tick of the Sunshine⇄Desktop GPU coexistence loop (the SLOW, 2s loop).

    STOP (backstop): whenever a Desktop session is present OR gamescope is gone,
    release the GPU by SIGKILLing Sunshine. The PRIMARY, fast release now lives in
    sunshine_release_tick() on a sub-second loop; this stays as a slower catch-all
    (e.g. a desktop session that appears while a gamescope process briefly overlaps).
    Also UNCONDITIONAL — a stream whose Game Mode is ending is already over, and
    holding card0 only deadlocks the desktop (see sunshine_release_tick). The
    force_stop does NOT set the user-stopped flag, so Sunshine auto-returns in Game
    Mode.

    START (debounced): only once stable_game_mode() holds — gamescope continuously up
    for a few seconds with no desktop — so a bouncing switch-to-Desktop never restarts
    Sunshine mid-transition and re-triggers the bounce. Returns a status string when it
    acted."""
    cfg = load_config()
    if resolved_engine(cfg) != "integrated" or not sunshine.is_installed():
        return None
    if desktop_session_active() or not in_game_mode():
        # Desktop is (about to be) up — free the GPU for KWin.
        if sunshine.is_running():
            # Fast SIGKILL: the GPU must free within a couple of seconds for KWin.
            # Low-level, so it does NOT set the user-stopped flag. Unconditional:
            # the release path deliberately does not spare a live stream.
            ok, _ = sunshine.force_stop()
            return "stopped Sunshine — Desktop Mode / not Game Mode (freeing GPU)" if ok else None
        return None
    # Game Mode: (re)start Sunshine if it should be running (and Game Mode is
    # stable). _autorestart_wanted rather than sunshine_should_autorestart: the
    # engine and is_installed checks above already answered that half, and
    # re-asking meant a second config load and a second flatpak probe per tick.
    if _autorestart_wanted(cfg):
        ok, _ = sunshine.start()
        if ok:
            apply_persisted_composition(cfg)
        return "started Sunshine for Game Mode" if ok else None
    return None


def _autorestart_wanted(cfg):
    """The watchdog conditions that DON'T re-check the engine: watchdog enabled,
    the user didn't stop it, Game Mode is stably up, and it isn't already
    running. For callers that just established the engine is integrated and
    Sunshine is installed."""
    if not cfg["settings"].get("sunshineWatchdog"):
        return False
    if _sunshine_user_stopped:
        return False
    if not stable_game_mode():
        return False
    return not sunshine.is_running()


def sunshine_should_autorestart(cfg=None):
    """True when Docky should (re)launch Sunshine: watchdog enabled, engine
    integrated, installed, the user didn't stop it, Game Mode is STABLY up (no desktop
    session, gamescope continuously present for a few seconds — Desktop needs the GPU
    and a bouncing switch must not trigger a restart), and it isn't already running."""
    cfg = cfg or load_config()
    if resolved_engine(cfg) != "integrated":
        return False
    if not sunshine.is_installed():
        return False
    return _autorestart_wanted(cfg)


def sunshine_autorestart():
    """Relaunch Sunshine after a crash and re-apply composition. (ok, message)."""
    ok, msg = sunshine.start()
    if ok:
        apply_persisted_composition()
    return ok, msg


def ensure_capture_healthy():
    """Detect and heal the 'running but capture is dead' state — Moonlight's
    "Error 503: Failed to initialize video capture/encoding". Sunshine can be up,
    responsive AND discoverable yet unable to capture: it builds its KMS/encoder
    pipeline once at launch and never rebuilds it, so a display that wasn't ready
    at that moment (docked boot, resume-from-sleep, a dock/undock that swapped the
    active connector) wedges every stream until a restart. The liveness watchdog
    can't see this (the process is fine), so capture gets its own heal.

    Two triggers, both ending in a restart that rebuilds capture against the
    CURRENT display:
      • proactive — the active display topology changed (dock/undock/output
        switch), which reliably stales KMS capture; rebuild while idle so the
        user's first connect after docking already works;
      • reactive — Sunshine's own log says the latest probe hit the no-display /
        no-encoder fatal.

    Heavily guarded against thrash: Game Mode + integrated + installed +
    user-not-stopped only; the reactive heal fires only on a DEFINITIVE log
    failure (never 'unknown'), debounced across ticks; both paths are
    rate-limited by a cooldown, gated on a display actually being lit, and capped
    so a genuinely unfixable failure can't spin. Never restarts mid-stream.
    Returns a status dict when it acts/observes something notable, else None."""
    # Non-blocking: if a heal is already running on another thread (the resume
    # hook), the cooldown would reject us anyway — so don't wait for it.
    if not _capture_lock.acquire(blocking=False):
        return None
    try:
        return _ensure_capture_healthy_locked()
    finally:
        _capture_lock.release()


def _ensure_capture_healthy_locked():
    global _capture_unhealthy_streak, _capture_failed_heals, _capture_last_heal
    global _last_active_outputs
    if resolved_engine() != "integrated" or not sunshine.is_installed():
        return None
    if _sunshine_user_stopped or not in_game_mode() or not sunshine.is_running():
        _capture_unhealthy_streak = 0
        return None
    if sunshine.is_streaming():
        # Capture is demonstrably working; never touch a live session.
        _capture_unhealthy_streak = 0
        _capture_failed_heals = 0
        return None

    now = time.monotonic()
    cooldown_ok = (now - _capture_last_heal) >= _CAPTURE_COOLDOWN
    display_lit = sunshine.display_active() is not False  # True/None → treat as lit

    # --- proactive: did the display topology change since we last looked? ---
    outs = sunshine.active_outputs()
    topo_changed = (_last_active_outputs is not None
                    and outs != _last_active_outputs and outs != "")
    _last_active_outputs = outs
    if topo_changed and display_lit and cooldown_ok:
        _capture_last_heal = now
        _capture_unhealthy_streak = 0
        _capture_failed_heals = 0
        return _capture_restart("display changed (%s) — rebuilt capture" % outs)

    # --- reactive: does Sunshine's log say capture is failing right now? ---
    if sunshine.capture_healthy() is not False:      # True (ok) or None (unknown)
        _capture_unhealthy_streak = 0
        _capture_failed_heals = 0
        return None
    _capture_unhealthy_streak += 1
    if _capture_unhealthy_streak < _CAPTURE_DEBOUNCE:
        return None
    if not display_lit:
        return {"ok": True, "healed": False,
                "message": "capture down but no display lit; waiting for one"}
    if not cooldown_ok:
        return None
    if _capture_failed_heals >= _CAPTURE_MAX_FAILED_HEALS:
        return {"ok": False, "healed": False,
                "message": "capture still failing after %d restarts; giving up "
                           "(check the display/encoder)" % _capture_failed_heals}
    _capture_last_heal = now
    _capture_unhealthy_streak = 0
    return _capture_restart("capture was failing — restarted to rebuild it")


def _capture_restart(success_msg):
    """Restart Sunshine to rebuild its capture pipeline (start() ensures
    `capture = kms` first), then confirm from the fresh startup probe whether
    capture recovered, updating the failed-heal cap counter. Returns a status
    dict. Callers must hold _capture_lock. Blocks up to ~5s waiting for the
    verdict; heals are cooldown-gated and rare, so that's fine on a watcher."""
    global _capture_failed_heals
    ok, msg = sunshine.restart()
    if not ok:
        _capture_failed_heals += 1
        return {"ok": False, "healed": False, "message": "capture restart failed: " + msg}
    apply_persisted_composition()
    # The fresh process truncates the log and writes a new probe verdict within a
    # second or two; read it back to see whether capture actually recovered.
    recovered = None
    for _ in range(10):
        time.sleep(0.5)
        v = sunshine.capture_healthy()
        if v is not None:
            recovered = v
            break
    if recovered is False:
        _capture_failed_heals += 1
        return {"ok": False, "healed": True,
                "message": "restarted but capture still failing"}
    _capture_failed_heals = 0
    return {"ok": True, "healed": True, "message": success_msg}


def sunshine_display_lit():
    """True if a display is currently lit (a connector connected+enabled+On) —
    used to wait for the panel to come back after resume before rebuilding
    capture."""
    return sunshine.display_active() is True


def rebuild_capture_after_resume():
    """Proactively rebuild Sunshine's capture pipeline after resume-from-sleep so
    the first post-resume connect already works. Resume reinitializes the display
    (gamescope atoms reset, the panel re-trains) but usually keeps the SAME
    connector set — so neither the reactive log check nor the topology detector
    would fire, yet Sunshine's once-at-launch capture pipeline can be stale. Same
    guards + shared cooldown as ensure_capture_healthy() so the periodic watchdog
    won't also restart. Returns a status dict, or None when not applicable."""
    if not _capture_lock.acquire(blocking=False):
        return None  # the periodic heal is already in there; it'll cover us
    try:
        return _rebuild_capture_after_resume_locked()
    finally:
        _capture_lock.release()


def _rebuild_capture_after_resume_locked():
    global _capture_last_heal, _capture_unhealthy_streak, _capture_failed_heals
    global _last_active_outputs
    if resolved_engine() != "integrated" or not sunshine.is_installed():
        return None
    if _sunshine_user_stopped or not in_game_mode() or not sunshine.is_running():
        return None
    if sunshine.is_streaming() or sunshine.display_active() is False:
        return None
    if (time.monotonic() - _capture_last_heal) < _CAPTURE_COOLDOWN:
        return None  # a heal just ran; don't pile on
    _capture_last_heal = time.monotonic()
    _capture_unhealthy_streak = 0
    _capture_failed_heals = 0
    _last_active_outputs = sunshine.active_outputs()  # rebaseline; avoid double-fire
    return _capture_restart("rebuilt capture after resume")


def ensure_mdns():
    """Keep Moonlight able to discover Sunshine. SteamOS ships avahi in
    resolve-only mode and re-disables publishing on updates, which silently
    kills discovery and the `<host>.local` fallback — the usual 'Sunshine keeps
    breaking' after a reboot/DHCP change. Enable + start + publish avahi, and if
    that changed anything while Sunshine is up but not yet advertising, restart
    it so it re-registers _nvstream (never mid-stream). Returns a status dict."""
    if resolved_engine() == "off":
        return {"ok": True, "message": "Sunshine off; mDNS skipped", "changed": False}
    ok, changed, msg = mdns.ensure()
    if not ok:
        return {"ok": False, "message": "mDNS: " + msg, "changed": changed}
    reregistered = False
    # Sunshine registers _nvstream only at startup; if avahi just came up or was
    # reconfigured, a running Sunshine stays invisible until restarted. Guard on
    # is_streaming() so we never drop a live session to fix discovery.
    if changed and sunshine.is_running() and not sunshine.is_streaming() \
            and not mdns.advertised():
        reregistered, _ = sunshine.restart()
        if reregistered:
            apply_persisted_composition()
    return {"ok": True, "message": "mDNS: " + msg,
            "changed": changed, "reregistered": reregistered}


def ensure_discoverable(settle_tries=4):
    """Confirm Sunshine is *actually* discoverable and heal it if not.

    ensure_mdns() only configures avahi and (re)registers when it changed
    something. But Sunshine registers its _nvstream record exactly once, at
    startup, and two things silently drop it with no config change and no error:
      1. the boot race — Sunshine registers into an avahi that isn't fully up
         yet (seen in logs: Sunshine binds ~1s before avahi goes active), so the
         record never lands; and
      2. avahi restarting later (a SteamOS update re-touching the daemon, a
         DHCP/network change) wiping every registration out from under Sunshine.
    In both cases avahi is healthy and Sunshine is running, yet Moonlight shows
    "host offline". This checks the real end state — is _nvstream on the wire? —
    and, if not, re-registers by restarting Sunshine. Never touches a live
    stream. Idempotent and cheap when already healthy. Returns a status dict."""
    if resolved_engine() == "off":
        return {"ok": True, "healed": False, "message": "Sunshine off"}
    if not sunshine.is_running():
        return {"ok": True, "healed": False, "message": "Sunshine not running"}
    # Make sure avahi itself is up/publishing before judging the record missing.
    mdns.ensure()
    # A just-started Sunshine can take a beat to publish; don't restart it out
    # from under a record that's about to appear. advertised() blocks while it
    # browses, so these tries are also the grace window.
    for _ in range(max(1, settle_tries)):
        if mdns.advertised():
            return {"ok": True, "healed": False, "message": "advertised"}
        if sunshine.is_streaming():
            # Reachable to the active client regardless; never drop a session.
            return {"ok": True, "healed": False,
                    "message": "not advertised but streaming; left alone"}
    # Still invisible and idle → re-register by restarting Sunshine.
    ok, msg = sunshine.restart()
    if ok:
        apply_persisted_composition()
    # Sunshine publishes _nvstream a beat after its port binds; give it a few
    # browse cycles to land before judging the re-register failed (advertised()
    # blocks while browsing, so this is also the wait).
    advertised = False
    for _ in range(3):
        if mdns.advertised():
            advertised = True
            break
    return {"ok": bool(ok and advertised), "healed": bool(ok),
            "message": ("re-registered; now advertised" if advertised
                        else "restarted but still not advertised (%s)" % msg)}


def set_sunshine_login(username, password):
    """Set/reset Sunshine's admin login and remember it for pairing."""
    ok, msg, auth = sunshine.set_login(username, password)
    if ok and auth:
        update_state(sunshineUser=username, sunshineAuth=auth)
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


def sunshine_set_client_enabled(uuid, enabled):
    st = load_state()
    ok, msg = sunshine.set_client_enabled(uuid, enabled, st.get("sunshineAuth"))
    return {"ok": ok, "message": msg}


# Trigger toggle keys -> the state field they baseline + how to read it now, so
# enabling a trigger acts only on the NEXT change rather than firing immediately.
_TRIGGER_BASELINE = {
    "autoDockDetection": ("lastDock", lambda cfg: is_docked(cfg)),
    "autoAcDetection": ("lastAc", lambda cfg: padswap.ac_present()),
    "autoControllerDetection": ("lastController", lambda cfg: deckops.external_controller_present()),
}


def set_trigger(key, enabled):
    """Enable/disable one automation trigger and baseline its current state.

    Read-modify-write under _config_lock like every other config mutator —
    without it this races the panel's fan/TDP quick controls and the editor's
    whole-object save, either of which can drop the toggle on the floor."""
    with _config_lock:
        cfg = load_config()
        if key not in cfg["settings"]:
            return cfg["settings"]
        cfg["settings"][key] = bool(enabled)
        save_config(cfg)
    base = _TRIGGER_BASELINE.get(key)
    if base:
        field, read = base
        # Outside the config lock: these probe hardware (sysfs/proc scans) and
        # take the state lock, which has no business nesting under this one.
        update_state(**{field: read(cfg)})
    return cfg["settings"]
