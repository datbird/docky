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
import re
import ssl
import json
import time
import base64
import glob
import shutil
import threading
import subprocess
import urllib.request
import urllib.error

from sysenv import clean_env as _clean_env  # strip Decky's PyInstaller LD_LIBRARY_PATH

APP_ID = "dev.lizardbyte.app.Sunshine"

# Sunshine is launched as root, so it stores its config under root's home.
CONF_PATH = "/root/.var/app/%s/config/sunshine/sunshine.conf" % APP_ID

# Encoder values Docky understands (""/auto lets Sunshine decide).
ENCODERS = ("", "vaapi", "vulkan", "software")

# The session user that owns display :0 and the audio socket.
SESSION_USER = "deck"
SESSION_UID = 1000


# The setuid-root bwrap copy must live on a setuid-honoring filesystem with a
# fully ROOT-OWNED path chain. /tmp and /run are nosuid on SteamOS; the Decky
# per-plugin data dir under ~deck is unsafe because the user owns an ancestor and
# could rename/replace it to plant a binary Docky would then make setuid-root.
# /var/lib is root-owned end-to-end and honors setuid.
_BWRAP_DIR = "/var/lib/docky"


def _bwrap_copy():
    return os.path.join(_BWRAP_DIR, "docky-bwrap")


def _audio_socket():
    for base in (os.environ.get("XDG_RUNTIME_DIR"), "/run/user/%d" % SESSION_UID):
        if base:
            sock = os.path.join(base, "pulse", "native")
            if os.path.exists(sock):
                return sock
    return None


def _launch_env():
    env = _clean_env()  # drop Decky's PyInstaller /tmp/_MEI… before we add /usr/lib
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


def _proc(args, timeout=5):
    """Run a small system binary quietly; True if it exited 0.

    env=_clean_env() is NOT optional, and this helper exists so it can't be
    forgotten again. Decky injects a PyInstaller LD_LIBRARY_PATH that makes
    system binaries load Decky's bundled libs and die at load time. That error
    goes to stderr — DEVNULL here — and the process exits non-zero, which is
    indistinguishable from pgrep's honest "found nothing". The consequences of a
    silently-False is_running() are not subtle: force_stop() would report
    "not running" and never free /dev/dri/card0 (the Desktop-switch deadlock),
    and the coexist loop's "not running" test would relaunch Sunshine every two
    seconds forever."""
    try:
        return subprocess.run(args, timeout=timeout,
                              stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL,
                              env=_clean_env()).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _flatpak(args, capture=True, timeout=120):
    """Run `flatpak <args>` with a clean env and a timeout. On timeout returns a
    CompletedProcess with a non-zero return code so callers fail soft rather than
    hang the (root) backend.

    The 120s default is sized for install/update. Anything that should be quick
    MUST pass its own timeout — a `flatpak kill` inheriting two minutes blocks a
    worker thread for two minutes."""
    argv = ["flatpak"] + args
    try:
        return subprocess.run(argv, capture_output=capture, text=True,
                              env=_clean_env(), timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(argv, 124, "", "flatpak timed out")
    except OSError as e:
        return subprocess.CompletedProcess(argv, 127, "", "flatpak unavailable: %s" % e)


# start/stop/restart are reachable concurrently from at least five places: the 2s
# coexist loop, the 6s liveness watchdog, the capture heal, the 20s mDNS heal,
# and the panel's buttons. main.py's start lock covers two of them and cannot
# cover restart() at all (ensure_capture_healthy and ensure_discoverable call it
# directly) — so ensure_discoverable's stop-then-start leaves a window for the
# coexist loop to see "not running" and launch a second Sunshine. The invariant
# belongs in the module that owns the process.
#
# Re-entrant because restart() calls stop() then start().
#
# force_stop() deliberately does NOT take it. It exists to free card0 within
# ~50ms, and start()'s come-up wait holds this for up to 10s. Killing a Sunshine
# that a concurrent start() is waiting on is the correct outcome anyway — that
# start() then honestly reports it didn't come up.
_lifecycle_lock = threading.RLock()


# is_installed/installed_scope are hit on every get_state poll; each is a flatpak
# subprocess. Cache the result briefly (the install state rarely changes) and
# invalidate explicitly after an install/update. Stored as a single (ts, val)
# tuple so a poll on one thread always reads a consistent pair.
#
# is_running() is deliberately NOT cached alongside it: `flatpak info` is a heavy
# process (~100ms+ of flatpak startup), while pgrep is a couple of milliseconds,
# and start()/stop() poll is_running() every 250ms to decide whether the process
# actually came up or went away — a TTL would make those waits lie.
_SCOPE_TTL = 15.0
_scope_cache = (-1e9, None)


def _invalidate_scope_cache():
    global _scope_cache
    _scope_cache = (-1e9, None)


def installed_scope(force=False):
    """'--system', '--user', or None — where the Sunshine flatpak is installed.
    Checks system first (Docky's + decky-sunshine's default), then a per-user
    install someone may have done manually. Result is cached for a few seconds."""
    global _scope_cache
    ts, cached = _scope_cache
    now = time.monotonic()
    if not force and (now - ts) < _SCOPE_TTL:
        return cached
    val = None
    for scope in ("--system", "--user"):
        if _flatpak(["info", scope, APP_ID], timeout=30).returncode == 0:
            val = scope
            break
    _scope_cache = (now, val)
    return val


def is_installed():
    return installed_scope() is not None


def is_running():
    # Detect the Sunshine process directly. `flatpak ps` proved unreliable in the
    # plugin's minimal env (it missed a clearly-running instance); the server's
    # process name is a stable, env-independent signal.
    return _proc(["pgrep", "-x", "sunshine"])


def _serverinfo(timeout=3):
    """Fetch Sunshine's unauthenticated Moonlight serverinfo XML, or None. This
    is the exact endpoint a Moonlight client hits first, so it's the truest
    'is Sunshine actually answering clients' signal."""
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:47989/serverinfo?uuid=docky", timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def is_responsive():
    """True if Sunshine answers its Moonlight serverinfo endpoint (a running
    process can still be wedged and not answer). NOTE: nothing in docky.py seems
    to call this — kept as the honest liveness probe if the watchdog ever wants
    something stronger than is_running()."""
    return _serverinfo() is not None


def is_streaming():
    """True while a Moonlight client is actively streaming — callers use this to
    avoid restarting Sunshine out from under a live session."""
    xml = _serverinfo()
    if not xml:
        return False
    if "SUNSHINE_SERVER_BUSY" in xml:
        return True
    m = re.search(r"<currentgame>(\d+)</currentgame>", xml)
    return bool(m and m.group(1) != "0")


FLATHUB_REPO = "https://flathub.org/repo/flathub.flatpakrepo"


def ensure_installed():
    """Install (or update) the Sunshine flatpak from flathub, system scope.

    Self-sufficient on a fresh machine: ensures the flathub system remote exists
    first (no-op if already configured), then installs from it explicitly so the
    install never depends on remote state another tool happened to leave behind."""
    if is_installed():
        return True, "Sunshine already installed"
    _ensure_flathub()
    res = _flatpak(["install", "--system", "--noninteractive", "--or-update",
                    "flathub", APP_ID], timeout=600)
    _invalidate_scope_cache()
    if res.returncode == 0:
        return True, "Sunshine installed"
    return False, (res.stderr or res.stdout or "install failed").strip()[:300]


def _ensure_flathub():
    """Add the flathub system remote if it isn't already configured (no-op if it
    is). Best-effort: failures are tolerated, the install/info call reports them."""
    _flatpak(["remote-add", "--if-not-exists", "--system", "flathub", FLATHUB_REPO],
             timeout=30)  # _flatpak soft-fails on timeout/OSError


def update():
    """Update the installed Sunshine flatpak to the latest on flathub."""
    if not is_installed():
        return False, "Sunshine is not installed"
    _ensure_flathub()
    res = _flatpak(["update", "--system", "--noninteractive", APP_ID], timeout=600)
    _invalidate_scope_cache()
    if res.returncode == 0:
        return True, "Sunshine updated"
    return False, (res.stderr or res.stdout or "update failed").strip()[:300]


def _parse_info(args):
    """Run `flatpak <args>` and parse its 'Key: value' output into a dict."""
    out = {}
    res = _flatpak(args, timeout=30)  # soft-fails internally
    if res.returncode != 0:
        return out
    for line in (res.stdout or "").splitlines():
        key, sep, val = line.partition(":")
        if sep:
            out[key.strip().lower()] = val.strip()
    return out


def version_info():
    """Report installed vs latest-on-flathub, and whether an update is available.
    Compares commits (robust) for update detection; versions are for display."""
    # Make sure flathub exists so 'latest' resolves even on a fresh machine.
    _ensure_flathub()
    scope = installed_scope()
    inst = scope is not None
    local = _parse_info(["info", scope, APP_ID]) if inst else {}
    remote = _parse_info(["remote-info", "--system", "flathub", APP_ID])
    ic, lc = local.get("commit", ""), remote.get("commit", "")
    return {
        "installed": inst,
        "installedVersion": local.get("version", ""),
        "latestVersion": remote.get("version", ""),
        "updateAvailable": bool(inst and ic and lc and ic != lc),
    }


def _prepare_bwrap():
    """Create the root-owned, setuid bwrap copy flatpak will use for capture.

    Security: never bless a pre-existing file with setuid-root (an unprivileged
    user could pre-plant a malicious binary there — a setuid TOCTOU). We make the
    directory root-owned and remove any existing copy, then copy fresh from the
    real /usr/bin/bwrap and set perms on the file we just created. The copy on
    every start is the point, not an oversight: it's what makes the "we set setuid
    only on bytes we just wrote" guarantee hold."""
    dst = _bwrap_copy()
    d = os.path.dirname(dst)
    try:
        # Remove the legacy setuid copy older Docky versions left under the
        # user-owned home (now considered unsafe).
        legacy = os.path.join(
            os.environ.get("DECKY_USER_HOME") or os.path.expanduser("~"),
            "homebrew", "data", "docky", "docky-bwrap")
        if os.path.lexists(legacy):
            os.remove(legacy)
        os.makedirs(d, exist_ok=True)
        os.chown(d, 0, 0)          # root-owned so the user can't write into it
        os.chmod(d, 0o755)
        if os.path.lexists(dst):    # discard anything already there
            os.remove(dst)
        shutil.copyfile("/usr/bin/bwrap", dst)
        os.chown(dst, 0, 0)
        os.chmod(dst, 0o4755)      # setuid root
        return True
    except OSError:
        return False


def _wait(predicate, tries=24, delay=0.25):
    for _ in range(tries):
        if predicate():
            return True
        time.sleep(delay)
    return predicate()


# Our most recent launch's Popen. We never wait() on it (Sunshine is detached),
# so when it exits — e.g. crashes — it becomes a zombie under the root backend.
# Poll it before the next launch to reap it, so repeated watchdog relaunches
# don't accumulate defunct docky-bwrap processes. Only ever our own child, so
# this can't disturb other threads' subprocess.run() calls. Guarded by
# _lifecycle_lock along with everything else that touches the process.
_last_proc = None


def _reap_last():
    global _last_proc
    if _last_proc is not None and _last_proc.poll() is not None:
        _last_proc = None  # previous launch exited; its child has been reaped


def start():
    """Launch Sunshine in the Game-Mode session. Returns (ok, message).

    Does NOT auto-install — installation is opt-in via Settings → Sunshine."""
    global _last_proc
    with _lifecycle_lock:
        if is_running():
            return True, "Sunshine already running"
        if not is_installed():
            return False, "Sunshine is not installed — install it in Settings → Sunshine"
        ensure_capture_kms()  # root-launched Sunshine needs KMS capture (else Error 503)
        _reap_last()
        if not _prepare_bwrap():
            return False, "could not prepare capture helper (bwrap)"
        try:
            # Launch from whichever scope it's installed in (system by default).
            scope = installed_scope() or "--system"
            # Detached so it outlives this request; its own session group.
            _last_proc = subprocess.Popen(
                ["flatpak", "run", scope, "--socket=wayland", APP_ID],
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
    with _lifecycle_lock:
        if not is_running():
            _reap_last()
            return True, "Sunshine not running"
        # Explicit timeout: _flatpak's 120s default is sized for install/update.
        # A kill that can block a worker thread for two minutes is not a kill.
        _flatpak(["kill", APP_ID], timeout=15)  # soft-fails internally
        # flatpak kill can miss it in the minimal env; fall back to a direct kill.
        if not _wait(lambda: not is_running(), tries=12):
            _proc(["pkill", "-9", "-x", "sunshine"])
        if _wait(lambda: not is_running()):
            _reap_last()
            return True, "Sunshine stopped"
        return False, "Sunshine still running"


def force_stop():
    """SIGKILL Sunshine (and its bwrap wrapper) immediately, to release held
    resources FAST — used when switching to Desktop, where Sunshine's KMS capture
    holds /dev/dri/card0 and KWin needs it within a couple of seconds. Skips the
    graceful flatpak-kill path.

    Deliberately takes NO lock: this has ~50ms to act and start() can hold
    _lifecycle_lock for ten seconds waiting to see whether Sunshine came up.
    Killing a Sunshine that a concurrent start() is waiting on is the right
    answer anyway. Returns (ok, message)."""
    if not is_running():
        return True, "Sunshine not running"
    # -i on the cmdline match: APP_ID is "…app.Sunshine" (capital S), and this
    # pattern was relying on the lowercase "/app/bin/sunshine" happening to
    # appear in bwrap's argv. Case-insensitivity costs nothing and removes the
    # dependency on that coincidence.
    for args in (["-9", "-x", "sunshine"], ["-9", "-i", "-f", "docky-bwrap.*sunshine"]):
        _proc(["pkill"] + args)
    if _wait(lambda: not is_running(), tries=12):
        return True, "Sunshine killed"
    return False, "Sunshine still running after kill"


def restart():
    """Stop then start (e.g. to apply a config change). Returns (ok, message)."""
    with _lifecycle_lock:
        ok, msg = stop()
        if not ok:
            # A failed stop means the old instance (with the old config) is still up;
            # start() would just report "already running" and mask that. Surface it.
            return False, "couldn't stop Sunshine: " + msg
        return start()


# ---- Capture health -------------------------------------------------------
#
# Sunshine builds its KMS capture + encoder pipeline once, at process start, and
# re-tests it only when a client connects. If that init fails — almost always
# because the display wasn't ready at that instant (a docked boot where the
# external panel hadn't finished coming up, a resume-from-sleep, or a dock/undock
# that swapped the active connector) — the process keeps running but every stream
# attempt returns "Error 503: Failed to initialize video capture/encoding". It
# does NOT rebuild the pipeline in-process; only a fresh start fixes it. Crucially
# is_running()/is_responsive() stay true throughout (serverinfo still answers), so
# a liveness check can't detect it. The one honest signal is Sunshine's own log:
# every probe ends in a decisive success ("Found H.264/HEVC encoder") or the fatal
# "Unable to find display or encoder". The most recent verdict is current health.

LOG_PATH = "/root/.var/app/%s/config/sunshine/sunshine.log" % APP_ID

_PROBE_OK = re.compile(r"Found (?:H\.264|HEVC|AV1) encoder")
_PROBE_FAIL = re.compile(
    r"Unable to find display or encoder|Video failed to find working encoder")


def _tail_text(path, max_bytes=65536):
    """Return roughly the last max_bytes of a text file decoded to str, or '' if
    it can't be read. Reads from the end so a long-lived log stays cheap."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def capture_healthy():
    """Judge Sunshine's capture/encoder pipeline from the most recent probe verdict
    in its log. Returns True (last probe found an encoder), False (last probe hit
    the 'no display / no encoder' fatal — the Error 503 state), or None (no verdict
    in view: unknown, so callers should do nothing). Keys ONLY off the decisive
    success/fatal lines — never the benign 'Encoder [x] failed' noise the startup
    auto-detection prints (which Sunshine itself labels safe to ignore)."""
    verdict = None
    for line in _tail_text(LOG_PATH).splitlines():
        if _PROBE_OK.search(line):
            verdict = True
        elif _PROBE_FAIL.search(line):
            verdict = False
    return verdict


def _drm_connectors():
    """Yield (name, status, enabled, dpms) for each DRM connector under sysfs.
    dpms defaults to 'On' when the attribute is absent (some connectors omit it;
    connected+enabled is then enough to consider it lit)."""
    for base in sorted(glob.glob("/sys/class/drm/card*-*/")):
        try:
            with open(os.path.join(base, "status")) as f:
                status = f.read().strip()
            with open(os.path.join(base, "enabled")) as f:
                enabled = f.read().strip()
        except OSError:
            continue
        try:
            with open(os.path.join(base, "dpms")) as f:
                dpms = f.read().strip()
        except OSError:
            dpms = "On"
        yield os.path.basename(base.rstrip("/")), status, enabled, dpms


def connector_state():
    """One sysfs pass answering both display questions: (lit, outputs).

    `lit` is display_active()'s tri-state, `outputs` is active_outputs()'s
    fingerprint. ensure_capture_healthy() asks both, back to back, off the same
    files — this lets it scan once. The two single-purpose functions below stay
    for callers that only want one."""
    read_any = False
    lit = False
    outs = []
    for name, status, enabled, dpms in _drm_connectors():
        read_any = True
        if status == "connected" and enabled == "enabled":
            outs.append(name)
            if dpms == "On":
                lit = True
    return (lit if read_any else None), ",".join(outs)


def display_active():
    """True if at least one connector is connected AND enabled AND powered on
    (dpms On) — something is actually lit to capture. False if connectors were
    readable but none are lit. None if sysfs couldn't be read at all. Gates a
    capture-heal restart: restarting into a dark display would just fail again."""
    return connector_state()[0]


def active_outputs():
    """A stable fingerprint of the compositor's active outputs: the connected AND
    enabled connectors (e.g. 'card0-DP-1'). Keys off connected+enabled only — NOT
    dpms — so it changes on a real dock/undock or output switch (which swaps the
    active connector and stales Sunshine's KMS capture) but NOT when the screen
    merely sleeps. '' if none / unreadable."""
    return connector_state()[1]


def ensure_capture_kms():
    """Guarantee `capture = kms` is in Sunshine's config. Launched as root inside
    the Game-Mode session, Sunshine can't use the wayland/portal capture backends
    (no user session bus), so with no explicit capture key it auto-picks one that
    fails as root → Error 503. Only writes when the key is ABSENT, so a user's
    deliberate choice is left alone. Returns (changed, message)."""
    try:
        lines = []
        if os.path.isfile(CONF_PATH):
            with open(CONF_PATH, "r", encoding="utf-8") as f:
                lines = f.read().splitlines()
        for ln in lines:
            if ln.partition("=")[0].strip().lower() == "capture":
                return False, "capture already configured"
        lines.append("capture = kms")
        _atomic_write(CONF_PATH, "\n".join(lines) + "\n")
    except OSError as e:
        return False, "could not write Sunshine config: %s" % e
    return True, "set capture = kms"


def _set_gamescope_atom(atom, enabled, what):
    """Set a boolean gamescope root-window atom (0/1) on the session user's
    display :0 — the atoms live there and gamescope reads them live. Set as the
    session user (Sunshine's backend runs as root). `what` names the feature for
    the status message. Returns (ok, message)."""
    value = "1" if enabled else "0"
    cmd = "DISPLAY=:0 xprop -root -f %s 32c -set %s %s" % (atom, atom, value)
    try:
        res = subprocess.run(["su", SESSION_USER, "-c", cmd], timeout=10,
                             capture_output=True, text=True, env=_clean_env())
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, "could not set %s: %s" % (what, e)
    if res.returncode == 0:
        return True, "%s %s" % (what, "on" if enabled else "off")
    return False, (res.stderr or "xprop failed").strip()[:200]


def _get_gamescope_atom(atom):
    """Return True if the boolean gamescope `atom` is currently set nonzero on :0."""
    cmd = "DISPLAY=:0 xprop -root %s" % atom
    try:
        res = subprocess.run(["su", SESSION_USER, "-c", cmd], timeout=10,
                             capture_output=True, text=True, env=_clean_env())
    except (OSError, subprocess.TimeoutExpired):
        return False
    out = (res.stdout or "").strip()
    if "=" not in out:  # "...: not found." when the atom is unset
        return False
    # Value is after '=', possibly a comma-separated 32c array ("1, 0, ...").
    first = out.rsplit("=", 1)[1].split(",")[0].strip()
    try:
        return int(first) != 0
    except ValueError:
        return False


def _apply_atom_mode(mode, getter, setter):
    """Apply an 'on' | 'off' | 'toggle' action to a boolean atom. Toggle flips
    the current value. Returns (ok, message)."""
    mode = (mode or "on").lower()
    if mode == "toggle":
        enabled = not getter()
    elif mode == "off":
        enabled = False
    else:
        enabled = True
    return setter(enabled)


def set_composition(enabled):
    """Force (or release) gamescope full-frame composition via its root-window
    atom, so a docked capture isn't squeezed/stretched."""
    return _set_gamescope_atom("GAMESCOPE_COMPOSITE_FORCE", enabled, "composition forced")


def get_composition():
    """Return True if GAMESCOPE_COMPOSITE_FORCE is currently set nonzero on :0."""
    return _get_gamescope_atom("GAMESCOPE_COMPOSITE_FORCE")


def apply_composition(mode):
    """Apply a composition action: 'on' | 'off' | 'toggle'. Returns (ok, message)."""
    return _apply_atom_mode(mode, get_composition, set_composition)


def set_hdr(enabled):
    """Enable/disable HDR output in the Game-Mode gamescope session via its
    GAMESCOPE_DISPLAY_HDR_ENABLED atom (writable at runtime, resets on reboot).
    The display + content must support HDR for it to have any visible effect."""
    return _set_gamescope_atom("GAMESCOPE_DISPLAY_HDR_ENABLED", enabled, "HDR")


def get_hdr():
    """Return True if GAMESCOPE_DISPLAY_HDR_ENABLED is currently set nonzero on :0."""
    return _get_gamescope_atom("GAMESCOPE_DISPLAY_HDR_ENABLED")


def apply_hdr(mode):
    """Apply an HDR action: 'on' | 'off' | 'toggle'. Returns (ok, message)."""
    return _apply_atom_mode(mode, get_hdr, set_hdr)


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


def _atomic_write(path, text):
    """Write text to path via a temp file + os.replace, so a crash/full-disk
    mid-write can't truncate a root-owned Sunshine config/state file (which would
    lose paired devices). Temp lives in the same dir so the replace is atomic.

    fsync before the replace, because os.replace only makes the RENAME atomic —
    the bytes may still be in page cache when it lands, so a hard power-off (which
    a handheld gets plenty of) leaves a zero-length file under the real name.
    That is precisely the "lose paired devices" outcome this function exists to
    prevent. Also carries the original mode across, so rewriting a 0600 state file
    doesn't silently widen it to the umask default."""
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    mode = None
    try:
        mode = os.stat(path).st_mode & 0o777
    except OSError:
        pass
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)
    try:
        dfd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


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
        _atomic_write(CONF_PATH, "\n".join(kept) + "\n")
    except OSError as e:
        return False, "could not write Sunshine config: %s" % e
    return True, "encoder set to %s (applies on next start)" % (value or "auto")


def status():
    return {"installed": is_installed(), "running": is_running()}


# ---- Web API: credentials + client pairing ----
#
# Sunshine exposes an HTTPS API on :47990 (self-signed cert). Pairing a Moonlight
# client means POSTing the PIN it shows to /api/pin with HTTP Basic auth. Setting
# the admin login is done via /api/password; when no login exists yet (first run)
# that endpoint accepts the new credentials without auth — which is also the
# supported way to reset a forgotten login, so Docky uses it to take ownership of
# the credentials it then stores. Facts only (endpoints/JSON shapes from Sunshine
# itself); no third-party code.

WEB_BASE = "https://localhost:47990"
STATE_FILE = "/root/.var/app/%s/config/sunshine/sunshine_state.json" % APP_ID

# Built ONCE. ssl.create_default_context() calls load_default_certs(), which reads
# and parses the whole system CA bundle (~200KB, hundreds of certs) — and the very
# next thing every caller did was set CERT_NONE, discarding all of it. set_login()
# alone calls _api() up to 41 times in its readiness loop. Sunshine's cert is
# self-signed on localhost, so there was never anything to verify; construct the
# context bare and skip the load entirely. SSLContext is safe to share across
# threads.
_SSL_CTX = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE


def basic_header(username, password):
    return base64.b64encode(("%s:%s" % (username, password)).encode()).decode()


def _api(path, method="GET", auth=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(WEB_BASE + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if auth:
        req.add_header("Authorization", "Basic " + auth)
    try:
        with urllib.request.urlopen(req, context=_SSL_CTX, timeout=8) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def _ok_status(resp):
    return '"status":true' in (resp or "").replace(" ", "")


def _snapshot_state():
    """(ok, raw_text_or_None, message). None text = the file doesn't exist yet
    (Sunshine has never run), which is the ONLY case where 'no previous state' is
    a legitimate answer."""
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return True, f.read(), ""
    except FileNotFoundError:
        return True, None, ""
    except OSError as e:
        return False, None, "could not read Sunshine state: %s" % e


def _clear_login(prev_text):
    """Blank the admin login, preserving everything else — paired devices live
    under "root" in the same file. Returns (ok, message).

    Takes the already-read text rather than reading it again, because the old
    version fell back to `data = {}` on ANY read or parse error and then wrote
    that out. A transient read failure or a momentarily-truncated file therefore
    replaced the entire state with three empty strings, silently unpairing every
    Moonlight client — the exact opposite of what its own comment promised. A
    missing file is the only error that legitimately means "nothing to keep"."""
    if prev_text is None:
        data = {}
    else:
        try:
            data = json.loads(prev_text)
        except ValueError as e:
            return False, "Sunshine state file is not valid JSON (%s); refusing " \
                          "to overwrite it and lose paired devices" % e
        if not isinstance(data, dict):
            return False, "Sunshine state file is not a JSON object; refusing to " \
                          "overwrite it"
    for k in ("username", "salt", "password"):
        data[k] = ""
    try:
        _atomic_write(STATE_FILE, json.dumps(data, indent=4))
    except OSError as e:
        return False, "could not write Sunshine state: %s" % e
    return True, ""


def _rollback_login(prev_text):
    """Put the pre-clear state back and restart so it takes effect.

    Best-effort, but not optional: between _clear_login() and a successful
    /api/password, Sunshine is in first-run state — its :47990 admin UI will hand
    ownership to whoever on the LAN reaches it first. Bailing out of set_login()
    without undoing the clear leaves it that way indefinitely."""
    try:
        if prev_text is None:
            if os.path.exists(STATE_FILE):
                os.remove(STATE_FILE)
        else:
            _atomic_write(STATE_FILE, prev_text)
    except OSError:
        return False
    restart()
    return True


def set_login(username, password):
    """Set Sunshine's admin login to the given credentials, without needing the
    old password (clears the login -> first-run -> sets it). Existing paired
    devices are preserved. Returns (ok, message, auth_header).

    Every failure path after the clear restores the previous state — see
    _rollback_login."""
    if not username or not password:
        return False, "username and password are required", None
    ok, prev, msg = _snapshot_state()
    if not ok:
        return False, msg, None
    ok, msg = _clear_login(prev)
    if not ok:
        return False, msg, None

    ok, msg = restart()
    if not ok:
        _rollback_login(prev)
        return False, "couldn't restart Sunshine: " + msg, None

    # Wait for the web API to answer (any response means it's up).
    for _ in range(40):
        code, _resp = _api("/api/apps")
        if code is not None:
            break
        time.sleep(0.25)
    code, resp = _api(
        "/api/password",
        method="POST",
        body={"newUsername": username, "newPassword": password, "confirmNewPassword": password},
    )
    if code == 200 and _ok_status(resp):
        return True, "Sunshine login set", basic_header(username, password)
    _rollback_login(prev)
    return False, "couldn't set login (HTTP %s) — previous login restored" % code, None


def pair(pin, name, auth):
    """Complete a Moonlight pairing by submitting its PIN. Returns (ok, message)."""
    if not auth:
        return False, "no Sunshine login set yet"
    if not pin:
        return False, "a PIN is required"
    code, resp = _api(
        "/api/pin",
        method="POST",
        auth=auth,
        body={"pin": str(pin), "name": name or "Moonlight"},
    )
    if code == 200 and _ok_status(resp):
        return True, "paired"
    if code == 200:
        return False, "pairing failed — check the PIN and that Moonlight is waiting"
    if code in (401, 403):
        return False, "Sunshine rejected the login — set it again"
    return False, "pairing error (HTTP %s)" % code


def list_clients(auth):
    """Return paired clients [{name, uuid, ...}], or None on error."""
    if not auth:
        return None
    code, resp = _api("/api/clients/list", auth=auth)
    if code == 200:
        try:
            return json.loads(resp).get("named_certs", [])
        except ValueError:
            return []
    return None


def unpair(uuid, auth):
    """Unpair a single client by uuid. Returns (ok, message)."""
    if not auth:
        return False, "no Sunshine login set yet"
    if not uuid:
        return False, "no device selected"
    code, _resp = _api("/api/clients/unpair", method="POST", auth=auth, body={"uuid": uuid})
    if code == 200:
        return True, "unpaired"
    if code in (401, 403):
        return False, "Sunshine rejected the login — set it again"
    return False, "unpair failed (HTTP %s)" % code


def unpair_all(auth):
    """Unpair every client. Returns (ok, message)."""
    if not auth:
        return False, "no Sunshine login set yet"
    code, _resp = _api("/api/clients/unpair-all", method="POST", auth=auth, body={})
    if code == 200:
        return True, "all devices unpaired"
    if code in (401, 403):
        return False, "Sunshine rejected the login — set it again"
    return False, "unpair failed (HTTP %s)" % code


def set_client_enabled(uuid, enabled, auth):
    """Enable or disable a paired client (stays paired, but can't connect when
    disabled). Sunshine's /api/clients/update. Returns (ok, message)."""
    if not auth:
        return False, "no Sunshine login set yet"
    if not uuid:
        return False, "no device selected"
    code, resp = _api("/api/clients/update", method="POST", auth=auth,
                      body={"uuid": uuid, "enabled": bool(enabled)})
    if code == 200 and _ok_status(resp):
        return True, "device " + ("enabled" if enabled else "disabled")
    if code in (401, 403):
        return False, "Sunshine rejected the login — set it again"
    return False, "update failed (HTTP %s)" % code
