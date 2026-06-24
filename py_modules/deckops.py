"""
Docky's built-in Steam Deck fixes for common dock/undock pain points.

All original Docky code, using only public platform facts (PipeWire/pactl sink
names, the Steam Deck controller's USB id 28de:1205, the amdgpu hwmon power cap,
flatpak). Everything runs from Docky's root backend; audio runs as the session
user since the PipeWire socket lives in that user's runtime dir.
"""

import os
import re
import glob
import shlex
import subprocess

from sysenv import clean_env as _clean_env  # strip Decky's PyInstaller LD_LIBRARY_PATH

SESSION_USER = "deck"
SESSION_UID = 1000

# Steam Deck built-in controller (Valve Software).
DECK_CONTROLLER_VID = "28de"
DECK_CONTROLLER_PID = "1205"


def _su_deck(cmd, timeout=15):
    """Run a shell command as the session user with their audio runtime dir.
    On timeout returns a non-zero code so callers fail soft."""
    full = "XDG_RUNTIME_DIR=/run/user/%d %s" % (SESSION_UID, cmd)
    try:
        res = subprocess.run(["su", SESSION_USER, "-c", full],
                             capture_output=True, text=True, env=_clean_env(),
                             timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as e:
        return 127, "", "su unavailable: %s" % e
    return res.returncode, (res.stdout or ""), (res.stderr or "")


# ---------------- audio output ----------------

# Preset target -> substrings to match against PipeWire sink names.
_AUDIO_PRESETS = {
    "hdmi": ["hdmi"],
    "speakers": ["Speaker"],
    "headphones": ["Headphone"],
}


def _list_sinks():
    code, out, _ = _su_deck("pactl list short sinks")
    sinks = []
    if code == 0:
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                sinks.append(parts[1])
    return sinks


def set_audio_output(target):
    """Set the default PipeWire sink to the first one matching `target`
    (preset like 'hdmi'/'speakers', or a substring of the sink name), and move
    any playing streams onto it. Returns (ok, message)."""
    target = (target or "").strip()
    if not target:
        return False, "no audio target given"
    sinks = _list_sinks()
    if not sinks:
        return False, "no audio sinks found"
    needles = _AUDIO_PRESETS.get(target.lower(), [target])
    match = None
    for s in sinks:
        if any(n.lower() in s.lower() for n in needles):
            match = s
            break
    if not match:
        return False, "no audio device matching '%s'" % target
    q = shlex.quote(match)  # sink names come from pactl but quote defensively
    code, _o, err = _su_deck("pactl set-default-sink " + q)
    if code != 0:
        return False, (err or "could not set default sink").strip()[:200]
    # Move already-playing streams onto the new default. Track failures so we
    # don't report success when the currently-playing app didn't actually follow.
    code, out, _ = _su_deck("pactl list short sink-inputs")
    moved_fail = 0
    if code == 0:
        for line in out.splitlines():
            sid = line.split("\t")[0].strip()
            if sid.isdigit():
                mc, _mo, _me = _su_deck("pactl move-sink-input %s %s" % (sid, q))
                if mc != 0:
                    moved_fail += 1
    if moved_fail:
        return True, "audio output -> %s (%d stream(s) couldn't move)" % (match, moved_fail)
    return True, "audio output -> %s" % match


# ---------------- built-in controller ----------------

def _controller_dev():
    """Sysfs bus id (e.g. '3-3') of the built-in controller, or None."""
    for d in glob.glob("/sys/bus/usb/devices/*"):
        try:
            with open(os.path.join(d, "idVendor")) as f:
                v = f.read().strip()
            with open(os.path.join(d, "idProduct")) as f:
                p = f.read().strip()
        except OSError:
            continue
        if v == DECK_CONTROLLER_VID and p == DECK_CONTROLLER_PID:
            return os.path.basename(d)
    return None


def builtin_controller_enabled():
    """True if the built-in controller is currently bound (active), False if
    unbound (disabled), or None if it can't be found."""
    dev = _controller_dev()
    if not dev:
        return None
    return os.path.exists("/sys/bus/usb/drivers/usb/" + dev)


def set_builtin_controller(enabled):
    """Enable (bind) or disable (unbind) the built-in controller so an external
    pad can own Player 1 when docked. Returns (ok, message)."""
    dev = _controller_dev()
    if not dev:
        return False, "built-in controller not found"
    bound = os.path.exists("/sys/bus/usb/drivers/usb/" + dev)
    if bound == bool(enabled):
        return True, "built-in controller already " + ("enabled" if enabled else "disabled")
    action = "bind" if enabled else "unbind"
    try:
        with open("/sys/bus/usb/drivers/usb/%s" % action, "w") as f:
            f.write(dev)
    except OSError as e:
        return False, "could not %s controller: %s" % (action, e)
    return True, "built-in controller " + ("enabled" if enabled else "disabled")


# ---------------- external controller detection ----------------

def external_controller_present():
    """True if a real external game controller is connected.

    Parses /proc/bus/input/devices. A genuine external pad has a joystick (jsN)
    handler, is NOT Valve's vendor 28de (which covers both the built-in Steam
    Controller and Steam Input's synthesized "X-Box 360 pad" outputs), and is
    NOT under /devices/virtual/input/ (where those synthesized pads live). Real
    USB/Bluetooth controllers sit on a real bus or under /virtual/misc/uhid/."""
    try:
        with open("/proc/bus/input/devices", encoding="utf-8", errors="ignore") as f:
            data = f.read()
    except OSError:
        return False
    for block in data.split("\n\n"):
        if not block.strip():
            continue
        has_js = False
        sysfs = vendor = ""
        for line in block.splitlines():
            if line.startswith("H:") and re.search(r"\bjs\d", line):
                has_js = True
            elif line.startswith("S:"):
                sysfs = line
            elif line.startswith("I:"):
                m = re.search(r"Vendor=([0-9a-fA-F]+)", line)
                if m:
                    vendor = m.group(1).lower()
        if has_js and "/virtual/input/" not in sysfs and vendor != "28de":
            return True
    return False


# ---------------- TDP (power cap) ----------------

def _amdgpu_cap():
    """Path to the amdgpu power1_cap (microwatts), or None."""
    for h in glob.glob("/sys/class/hwmon/hwmon*"):
        try:
            with open(os.path.join(h, "name")) as f:
                name = f.read().strip()
        except OSError:
            continue
        cap = os.path.join(h, "power1_cap")
        if name == "amdgpu" and os.path.exists(cap):
            return cap
    return None


def set_tdp(watts):
    """Clamp the APU power budget to `watts` via amdgpu's power cap (the
    docked-vs-handheld performance knob). Returns (ok, message)."""
    try:
        w = int(watts)
    except (ValueError, TypeError):
        return False, "invalid wattage: %r" % (watts,)
    if w <= 0:
        return False, "wattage must be positive"
    cap = _amdgpu_cap()
    if not cap:
        return False, "no amdgpu power cap on this device"
    uw = w * 1_000_000
    try:
        def _read(p):
            with open(p) as f:
                return int(f.read().strip())
        if os.path.exists(cap + "_max"):
            uw = min(uw, _read(cap + "_max"))
        # Don't let a too-low cap throttle the APU into the ground.
        if os.path.exists(cap + "_min"):
            uw = max(uw, _read(cap + "_min"))
        with open(cap, "w") as f:
            f.write(str(uw))
    except (OSError, ValueError) as e:
        return False, "could not set TDP: %s" % e
    return True, "TDP set to %dW" % (uw // 1_000_000)


def get_tdp():
    """Current APU power cap in whole watts plus the max settable, e.g.
    {"watts": 15, "max": 28}. Empty dict if there's no amdgpu cap."""
    cap = _amdgpu_cap()
    if not cap:
        return {}
    out = {}
    cur = _read_int(cap)
    if cur is not None:
        out["watts"] = int(round(cur / 1_000_000.0))
    mx = _read_int(cap + "_max")
    if mx is not None:
        out["max"] = int(mx / 1_000_000)
    return out


def reset_tdp():
    """Lift Docky's power cap by restoring it to the hardware max, handing TDP
    back to SteamOS/Steam. Returns (ok, message)."""
    cap = _amdgpu_cap()
    if not cap:
        return False, "no amdgpu power cap on this device"
    mx = _read_int(cap + "_max")
    if mx is None:
        return False, "no power cap max to restore"
    try:
        with open(cap, "w") as f:
            f.write(str(mx))
    except OSError as e:
        return False, "could not reset TDP: %s" % e
    return True, "TDP reset to default (%dW)" % (mx // 1_000_000)


# ---------------- Fan control + curve engine (steamdeck_hwmon) ----------------
#
# Replicates Fantastic's capability set without any of its code: a temperature->
# RPM curve (with optional interpolation), manual fixed RPM, or hand back to
# SteamOS. The Deck fan is driven by writing steamdeck_hwmon/fan1_target (RPM);
# SteamOS's own jupiter-fan-control daemon rewrites that target every poll, so it
# must be stopped before any value will stick and restarted to return to auto.

# SteamOS's stock fan daemon.
FAN_SERVICE = "jupiter-fan-control.service"
# Sane ceiling for the Deck blower (OLED tops ~7300 RPM, LCD ~6300); clamp so a
# fat-fingered value can't ask the EC for something absurd.
FAN_MAX_RPM = 8000

# Built-in starter curve: (temperature °C, target RPM). Gentle ramp that stays
# quiet at idle and spins up under sustained load. Users edit this in the UI.
DEFAULT_FAN_CURVE = [
    {"temp": 45, "rpm": 0},
    {"temp": 55, "rpm": 1800},
    {"temp": 65, "rpm": 3200},
    {"temp": 75, "rpm": 4800},
    {"temp": 85, "rpm": 6500},
]


def _hwmon_named(name):
    """Path of the hwmonN whose `name` matches, or None."""
    for h in glob.glob("/sys/class/hwmon/hwmon*"):
        try:
            with open(os.path.join(h, "name")) as f:
                if f.read().strip() == name:
                    return h
        except OSError:
            continue
    return None


def _fan_target_path():
    """Path to steamdeck_hwmon fan1_target (the RPM the EC aims for), or None."""
    h = _hwmon_named("steamdeck_hwmon")
    if h:
        tgt = os.path.join(h, "fan1_target")
        if os.path.exists(tgt):
            return tgt
    return None


def _read_int(path):
    try:
        with open(path) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def read_fan_rpm():
    """Current fan speed in RPM (fan1_input), or None."""
    h = _hwmon_named("steamdeck_hwmon")
    return _read_int(os.path.join(h, "fan1_input")) if h else None


def read_fan_target():
    """Current commanded fan target in RPM (fan1_target), or None."""
    p = _fan_target_path()
    return _read_int(p) if p else None


def read_temp_c():
    """APU temperature in whole °C used to drive the curve.

    Prefer amdgpu's edge sensor (the APU die); fall back to the hottest
    /sys/class/thermal zone. Returns an int °C, or None if nothing readable."""
    h = _hwmon_named("amdgpu")
    if h:
        uc = _read_int(os.path.join(h, "temp1_input"))  # millidegrees C
        if uc is not None:
            return int(round(uc / 1000.0))
    hottest = None
    for z in glob.glob("/sys/class/thermal/thermal_zone*/temp"):
        v = _read_int(z)
        if v is not None:
            c = v / 1000.0
            hottest = c if hottest is None else max(hottest, c)
    return int(round(hottest)) if hottest is not None else None


def jupiter_fan_active():
    """True if SteamOS's stock fan daemon is currently running."""
    try:
        r = subprocess.run(["systemctl", "is-active", FAN_SERVICE],
                           capture_output=True, text=True, env=_clean_env(),
                           timeout=10)
        return r.stdout.strip() == "active"
    except (OSError, subprocess.SubprocessError):
        return False


def _fan_service(action):
    """start/stop/restart the OS fan daemon; best-effort (absent on non-Deck)."""
    try:
        subprocess.run(["systemctl", action, FAN_SERVICE],
                       capture_output=True, text=True, env=_clean_env(),
                       timeout=15)
    except (OSError, subprocess.SubprocessError):
        pass


def curve_rpm(temp_c, points, interpolate=True):
    """Map a temperature to a target RPM using the curve `points`
    (list of {temp, rpm}). Below/above the curve ends clamp to the end values.
    Between points: linear interpolation, or the lower point's RPM if stepped.
    Returns an int RPM clamped to [0, FAN_MAX_RPM], or None if no usable points."""
    pts = []
    for p in points or []:
        try:
            pts.append((float(p["temp"]), float(p["rpm"])))
        except (KeyError, TypeError, ValueError):
            continue
    if not pts:
        return None
    pts.sort(key=lambda x: x[0])
    if temp_c is None:
        # No reading: be safe, hold the curve's top RPM.
        rpm = pts[-1][1]
    elif temp_c <= pts[0][0]:
        rpm = pts[0][1]
    elif temp_c >= pts[-1][0]:
        rpm = pts[-1][1]
    else:
        rpm = pts[-1][1]
        for (t0, r0), (t1, r1) in zip(pts, pts[1:]):
            if t0 <= temp_c <= t1:
                if interpolate and t1 != t0:
                    rpm = r0 + (r1 - r0) * (temp_c - t0) / (t1 - t0)
                else:
                    rpm = r0
                break
    return max(0, min(FAN_MAX_RPM, int(round(rpm))))


def write_fan_rpm(rpm):
    """Hold a fixed fan target. Stops the stock daemon first (only if running, so
    this is cheap to call repeatedly from the control loop). Returns (ok, msg)."""
    try:
        r = int(rpm)
    except (ValueError, TypeError):
        return False, "invalid fan RPM: %r" % (rpm,)
    if r < 0:
        return False, "fan RPM must be >= 0"
    tgt = _fan_target_path()
    if not tgt:
        return False, "no steamdeck_hwmon fan on this device"
    r = min(r, FAN_MAX_RPM)
    if jupiter_fan_active():
        _fan_service("stop")
    try:
        with open(tgt, "w") as f:
            f.write(str(r))
    except OSError as e:
        return False, "could not set fan: %s" % e
    return True, "fan target %d RPM" % r


def restore_auto_fan():
    """Hand the fan back to SteamOS (restart jupiter-fan-control)."""
    _fan_service("restart")
    return True, "fan returned to automatic control"


# ---------------- flatpak maintenance ----------------

def flatpak_update(app=""):
    """Update a flatpak app (blank = everything), system scope. (ok, message)."""
    args = ["flatpak", "update", "--system", "--noninteractive"]
    if app:
        args.append(app)
    try:
        res = subprocess.run(args, capture_output=True, text=True, env=_clean_env(),
                             timeout=600)
    except subprocess.TimeoutExpired:
        return False, "flatpak update timed out"
    except OSError as e:
        return False, "flatpak not available: %s" % e
    if res.returncode == 0:
        return True, "flatpak update complete" + (" (%s)" % app if app else "")
    return False, (res.stderr or res.stdout or "update failed").strip()[:300]
