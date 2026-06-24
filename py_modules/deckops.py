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
    return res.returncode, (res.stdout or ""), (res.stderr or "")


# ---------------- audio output ----------------

# Preset target -> substrings to match against PipeWire sink names.
_AUDIO_PRESETS = {
    "hdmi": ["hdmi"],
    "speakers": ["Speaker"],
    "headphones": ["Headphone"],
    "internal": ["Speaker"],
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
    # Move already-playing streams onto the new default.
    code, out, _ = _su_deck("pactl list short sink-inputs")
    if code == 0:
        for line in out.splitlines():
            sid = line.split("\t")[0].strip()
            if sid.isdigit():
                _su_deck("pactl move-sink-input %s %s" % (sid, q))
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
