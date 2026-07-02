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
            # Force HDR output in the Game-Mode gamescope session (its
            # GAMESCOPE_DISPLAY_HDR_ENABLED atom). Like composition it's a
            # runtime-only atom that resets every boot, so Docky persists the
            # preference here and re-applies it on load. Display + content must
            # support HDR for it to have visible effect.
            "forceHdr": False,
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
                "points": list(deckops.DEFAULT_FAN_CURVE),
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


# config.json is read-modify-written by several frontend-triggered paths (panel
# fan/TDP quick controls + the editor's full-config save), all on worker threads
# via asyncio.to_thread. Serialize read→modify→write so a whole-object save can't
# clobber a field another writer just set. Re-entrant so a helper holding the lock
# can still call save_config(). Wrap multi-step updates in `with _config_lock:`.
_config_lock = threading.RLock()


def save_config(cfg):
    with _config_lock:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, CONFIG_PATH)
        # Keep the config user-owned/editable even though the backend runs as root.
        _chown_to_parent(CONFIG_DIR)
        _chown_to_parent(CONFIG_PATH)


# state.json is read-modify-written by both the trigger watcher and frontend
# calls (some via asyncio.to_thread, i.e. a worker thread). Serialize updates so a
# full-object save can't clobber a field another writer just set (e.g. the watcher
# overwriting an activeMode that a fired trigger just wrote).
_state_lock = threading.Lock()


def load_state():
    return _read_json(STATE_PATH, {})


def save_state(state):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)
    _chown_to_parent(CONFIG_DIR)
    _chown_to_parent(STATE_PATH)


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


def suggested_mode(cfg=None, docked=None):
    cfg = cfg or load_config()
    s = cfg["settings"]
    if docked is None:
        docked = is_docked(cfg)
    return s["dockedMode"] if docked else s["undockedMode"]


# ---------------- fan control (Fantastic-style curve engine) ----------------

def _fan_settings(cfg=None):
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
    s = _fan_settings(cfg)
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
    if mode == "auto":
        ok, msg = fan_release()
    else:
        res = fan_apply(cfg)
        ok, msg = res["ok"], res["message"]
    return {"ok": ok, "message": msg, "fan": fan_status(cfg)}


def apply_fan_profile(profile_id):
    """Load a saved fan profile into the active fan settings and apply it.
    profile_id "" / "auto" returns the fan to SteamOS. Returns {ok, message, fan}."""
    if not profile_id or profile_id == "auto":
        res = set_fan_mode("auto")
        return res
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
    if s["fanMode"] == "auto":
        ok, msg = fan_release()
    else:
        res = fan_apply(cfg)
        ok, msg = res["ok"], res["message"]
    return {"ok": ok, "message": "applied fan profile '%s'" % prof.get("name", profile_id)
            if ok else msg, "fan": fan_status(cfg)}


def fan_status(cfg=None):
    """Live fan state for the UI: mode, current temp/RPM, commanded target, and
    the curve settings."""
    s = _fan_settings(cfg)
    fc = s.get("fanCurve") or {}
    return {
        "mode": s.get("fanMode", "auto"),
        "tempC": deckops.read_temp_c(),
        "rpm": deckops.read_fan_rpm(),
        "target": deckops.read_fan_target(),
        "manualRpm": s.get("fanManualRpm", 0),
        "interpolate": fc.get("interpolate", True),
        "points": fc.get("points") or [],
        "available": deckops._fan_target_path() is not None,
        "maxRpm": deckops.FAN_MAX_RPM,
        "profile": s.get("fanProfile", ""),
    }


# ---------------- TDP (power cap) ----------------

def set_tdp_watts(watts, mark_manual=True):
    """Apply a TDP cap now and persist it as the active value. mark_manual clears
    the active-profile marker (a hand-set watts isn't a saved profile)."""
    ok, msg = deckops.set_tdp(watts)
    if ok:
        with _config_lock:
            cfg = load_config()
            cfg["settings"]["tdpWatts"] = max(1, int(watts))  # set_tdp already validated
            if mark_manual:
                cfg["settings"]["tdpProfile"] = ""
            save_config(cfg)
    return {"ok": ok, "message": msg, "tdp": tdp_status()}


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
    return {"ok": ok, "message": "applied TDP profile '%s'" % prof.get("name", profile_id)
            if ok else msg, "tdp": tdp_status()}


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
    s = _fan_settings(cfg)
    return deckops.set_tdp(s.get("tdpWatts", 15))


def release_control():
    """Disable all Docky hardware control: hand the fan back to SteamOS and lift
    the TDP cap to its default (enforcement off). Returns {ok, message, fan, tdp}."""
    fan = set_fan_mode("auto")          # fanMode=auto, fanProfile="", restarts daemon
    with _config_lock:
        cfg = load_config()
        cfg["settings"]["tdpEnforce"] = False
        cfg["settings"]["tdpProfile"] = ""
        save_config(cfg)
    ok_t, msg_t = deckops.reset_tdp()
    ok = bool(fan.get("ok", True)) and ok_t
    return {"ok": ok,
            "message": "Handed control back to SteamOS" if ok else (msg_t or fan.get("message", "")),
            "fan": fan_status(), "tdp": tdp_status()}


def tdp_status(cfg=None):
    """Live TDP state for the UI."""
    s = _fan_settings(cfg)
    info = deckops.get_tdp()
    return {
        "watts": info.get("watts"),          # current hardware cap
        "setWatts": s.get("tdpWatts", 15),   # configured/last-applied
        "max": info.get("max", 15),
        "enforce": bool(s.get("tdpEnforce", False)),
        "profile": s.get("tdpProfile", ""),
        "available": bool(info),
    }


def _task_bool_status(task):
    """Current on/off state of a stateful task, or None if it has no readable
    state. Add a task type here to give it a live status LED on its buttons."""
    t = task.get("type")
    if t == "sunshine_composition":
        return sunshine.get_composition()
    if t == "sunshine_hdr":
        return sunshine.get_hdr()
    if t == "builtin_controller":
        return deckops.builtin_controller_enabled()
    return None


def _task_mode(task):
    """on/off/toggle for a stateful task. New tasks carry `mode`; older ones had a
    boolean `enabled` — fall back to that for backward compatibility."""
    return task.get("mode") or ("on" if task.get("enabled") else "off")


def _task_verb(task):
    """Verb describing what a stateful task does, for its button label
    ("On"/"Off"/"Toggle"), or None for non-stateful tasks."""
    t = task.get("type")
    if t in ("sunshine_composition", "sunshine_hdr", "builtin_controller"):
        return {"on": "On", "off": "Off", "toggle": "Toggle"}.get(_task_mode(task), "Toggle")
    return None


def _action_control(action):
    """For an action's first stateful task: its live on/off status and the verb
    it performs. {status: None, verb: None} when nothing stateful."""
    for task in action.get("tasks", []):
        s = _task_bool_status(task)
        if s is not None:
            return {"status": bool(s), "verb": _task_verb(task)}
    return {"status": None, "verb": None}


def _resolved_favorites(cfg):
    """Resolve config favorites into panel-ready entries with names, flagging
    any whose referenced action/mode no longer exists. Action favorites also
    carry a live on/off `status` when their action has a stateful task."""
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
        ctrl = (_action_control(item) if (item and kind == "action")
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
                         forceHdr=bool((cfg.get("settings") or {}).get("forceHdr")),
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


def sunshine_engine(cfg=None):
    """The raw sunshineEngine setting ('auto' by default)."""
    eng = ((cfg or load_config()).get("settings", {}) or {}).get("sunshineEngine")
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
    cfg = cfg or load_config()
    enabled = bool((cfg.get("settings") or {}).get("forceComposition"))
    return sunshine.set_composition(enabled)


def set_force_composition(enabled):
    """Persist the force-composition preference and apply it live now."""
    enabled = bool(enabled)
    with _config_lock:
        cfg = load_config()
        cfg["settings"]["forceComposition"] = enabled
        save_config(cfg)
    ok, msg = sunshine.set_composition(enabled)
    return {"ok": ok, "message": msg, "forceComposition": enabled}


def apply_persisted_hdr(cfg=None):
    """Re-apply the saved force-HDR preference to gamescope's runtime atom
    (which resets every boot). Returns (ok, message)."""
    cfg = cfg or load_config()
    enabled = bool((cfg.get("settings") or {}).get("forceHdr"))
    return sunshine.set_hdr(enabled)


def set_force_hdr(enabled):
    """Persist the force-HDR preference and apply it live now."""
    enabled = bool(enabled)
    with _config_lock:
        cfg = load_config()
        cfg["settings"]["forceHdr"] = enabled
        save_config(cfg)
    ok, msg = sunshine.set_hdr(enabled)
    return {"ok": ok, "message": msg, "forceHdr": enabled}


def set_sunshine_watchdog(enabled):
    """Persist whether the watchdog should keep an integrated Sunshine alive."""
    enabled = bool(enabled)
    with _config_lock:
        cfg = load_config()
        cfg["settings"]["sunshineWatchdog"] = enabled
        save_config(cfg)
    return {"ok": True, "watchdog": enabled,
            "message": "watchdog " + ("on" if enabled else "off")}


def sunshine_should_autorestart():
    """True when Docky should relaunch a crashed Sunshine: watchdog enabled,
    engine integrated, installed, the user didn't stop it, and it isn't running.
    """
    cfg = load_config()
    if not cfg["settings"].get("sunshineWatchdog"):
        return False
    if _sunshine_user_stopped:
        return False
    if resolved_engine(cfg) != "integrated":
        return False
    if not sunshine.is_installed():
        return False
    return not sunshine.is_running()


def sunshine_autorestart():
    """Relaunch Sunshine after a crash and re-apply composition. (ok, message)."""
    ok, msg = sunshine.start()
    if ok:
        apply_persisted_composition()
    return ok, msg


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
    """Enable/disable one automation trigger and baseline its current state."""
    cfg = load_config()
    if key not in cfg["settings"]:
        return cfg["settings"]
    cfg["settings"][key] = bool(enabled)
    save_config(cfg)
    base = _TRIGGER_BASELINE.get(key)
    if base:
        field, read = base
        update_state(**{field: read(cfg)})
    return cfg["settings"]
