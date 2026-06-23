"""
Docky's self-contained control of the LizardByte Sunshine flatpak.

This is original Docky code. It relies only on public facts about the platform
(the Sunshine flatpak app id, standard flatpak/xprop invocations, the env vars
flatpak/Sunshine read, the gamescope composite atom, and Sunshine's `encoder`
config key) — none of another project's code.

Why the setuid-bwrap dance: a normal flatpak sandbox can't obtain the
privileges Sunshine's KMS screen capture needs inside the Game-Mode gamescope
session. Pointing flatpak at a root-owned, setuid copy of bwrap (via the
FLATPAK_BWRAP env var) lets the sandbox elevate enough for capture. Docky's
backend already runs as root, so it can create that copy and launch the
system flatpak. The capture also has to reach the live session display (:0)
and the user's audio socket.
"""

import os
import time
import subprocess

APP_ID = "dev.lizardbyte.app.Sunshine"

# Sunshine is launched as root, so it stores its config under root's home.
CONF_PATH = "/root/.var/app/%s/config/sunshine/sunshine.conf" % APP_ID

# Encoder values Docky understands (""/auto lets Sunshine decide).
ENCODERS = ("", "vaapi", "vulkan", "software")

# The session user that owns display :0 and the audio socket.
SESSION_USER = "deck"
SESSION_UID = 1000


def _runtime_dir():
    # The setuid bwrap copy must live on a filesystem that honors setuid. On
    # SteamOS /tmp and /run are mounted nosuid, so we use Decky's per-plugin data
    # dir under the user's home (which allows setuid).
    home = os.environ.get("DECKY_USER_HOME") or os.path.expanduser("~")
    return os.path.join(home, "homebrew", "data", "docky")


def _bwrap_copy():
    return os.path.join(_runtime_dir(), "docky-bwrap")


def _audio_socket():
    for base in (os.environ.get("XDG_RUNTIME_DIR"), "/run/user/%d" % SESSION_UID):
        if base:
            sock = os.path.join(base, "pulse", "native")
            if os.path.exists(sock):
                return sock
    return None


def _launch_env():
    env = os.environ.copy()
    # Sunshine runs as root; keep its config under /root (matches CONF_PATH).
    env["HOME"] = "/root"
    env["DISPLAY"] = ":0"
    env["FLATPAK_BWRAP"] = _bwrap_copy()
    # Expose host libraries so the sandboxed capture stack matches the running
    # compositor/driver.
    env["LD_LIBRARY_PATH"] = "/usr/lib/:" + env.get("LD_LIBRARY_PATH", "")
    sock = _audio_socket()
    if sock:
        env["PULSE_SERVER"] = "unix:" + sock
    return env


def _flatpak(args, capture=True):
    return subprocess.run(["flatpak"] + args, capture_output=capture, text=True)


def is_installed():
    try:
        return _flatpak(["info", "--system", APP_ID]).returncode == 0
    except OSError:
        return False


def is_running():
    # Detect the Sunshine process directly. `flatpak ps` proved unreliable in the
    # plugin's minimal env (it missed a clearly-running instance); the server's
    # process name is a stable, env-independent signal.
    try:
        return subprocess.run(["pgrep", "-x", "sunshine"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    except OSError:
        return False


def ensure_installed():
    """Install (or update) the Sunshine flatpak from flathub, system scope."""
    if is_installed():
        return True, "Sunshine already installed"
    try:
        res = _flatpak(["install", "--system", "--noninteractive", "--or-update", APP_ID])
    except OSError as e:
        return False, "flatpak not available: %s" % e
    if res.returncode == 0:
        return True, "Sunshine installed"
    return False, (res.stderr or res.stdout or "install failed").strip()[:300]


def _prepare_bwrap():
    """Create the root-owned, setuid bwrap copy flatpak will use for capture."""
    dst = _bwrap_copy()
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst):
            subprocess.run(["cp", "/usr/bin/bwrap", dst], check=True)
        subprocess.run(["chown", "root:root", dst], check=True)
        subprocess.run(["chmod", "u+s", dst], check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def _wait(predicate, tries=24, delay=0.25):
    for _ in range(tries):
        if predicate():
            return True
        time.sleep(delay)
    return predicate()


def start():
    """Launch Sunshine in the Game-Mode session. Returns (ok, message)."""
    if is_running():
        return True, "Sunshine already running"
    ok, msg = ensure_installed()
    if not ok:
        return False, msg
    if not _prepare_bwrap():
        return False, "could not prepare capture helper (bwrap)"
    try:
        # Detached so it outlives this request; its own session group.
        subprocess.Popen(
            ["flatpak", "run", "--system", "--socket=wayland", APP_ID],
            env=_launch_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid,
        )
    except OSError as e:
        return False, "launch failed: %s" % e
    if _wait(is_running, tries=40):
        return True, "Sunshine started"
    return False, "Sunshine did not come up"


def stop():
    """Terminate the Sunshine flatpak. Returns (ok, message)."""
    if not is_running():
        return True, "Sunshine not running"
    try:
        _flatpak(["kill", APP_ID])
    except OSError:
        pass
    # flatpak kill can miss it in the minimal env; fall back to a direct kill.
    if not _wait(lambda: not is_running(), tries=12):
        subprocess.run(["pkill", "-9", "-x", "sunshine"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if _wait(lambda: not is_running()):
        return True, "Sunshine stopped"
    return False, "Sunshine still running"


def restart():
    """Stop then start (e.g. to apply a config change). Returns (ok, message)."""
    stop()
    return start()


def set_composition(enabled):
    """Force (or release) gamescope full-frame composition via its root-window
    atom, so a docked capture isn't squeezed/stretched. Set as the session user
    because the atom lives on that user's display :0."""
    value = "1" if enabled else "0"
    cmd = ("DISPLAY=:0 xprop -root -f GAMESCOPE_COMPOSITE_FORCE 32c "
           "-set GAMESCOPE_COMPOSITE_FORCE " + value)
    try:
        res = subprocess.run(["su", SESSION_USER, "-c", cmd],
                             capture_output=True, text=True)
    except OSError as e:
        return False, "could not set composition: %s" % e
    if res.returncode == 0:
        return True, "composition forced %s" % ("on" if enabled else "off")
    return False, (res.stderr or "xprop failed").strip()[:200]


def get_encoder():
    """Return the encoder currently set in Sunshine's config ('' = auto)."""
    try:
        with open(CONF_PATH, "r", encoding="utf-8") as f:
            for line in f:
                key, _, val = line.partition("=")
                if key.strip().lower() == "encoder":
                    return val.strip()
    except OSError:
        pass
    return ""


def set_encoder(value):
    """Write `encoder = value` into Sunshine's config ('' removes it -> auto).
    Sunshine reads its config at launch, so this takes effect on the next start.
    Returns (ok, message)."""
    if value not in ENCODERS:
        return False, "unknown encoder: %r" % value
    try:
        lines = []
        if os.path.isfile(CONF_PATH):
            with open(CONF_PATH, "r", encoding="utf-8") as f:
                lines = f.read().splitlines()
        kept = [ln for ln in lines if ln.partition("=")[0].strip().lower() != "encoder"]
        if value:
            kept.append("encoder = %s" % value)
        os.makedirs(os.path.dirname(CONF_PATH), exist_ok=True)
        with open(CONF_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join(kept) + "\n")
    except OSError as e:
        return False, "could not write Sunshine config: %s" % e
    return True, "encoder set to %s (applies on next start)" % (value or "auto")


def status():
    return {"installed": is_installed(), "running": is_running()}
