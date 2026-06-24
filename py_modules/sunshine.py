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
import ssl
import json
import time
import base64
import subprocess
import urllib.request
import urllib.error

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


# Decky's plugin_loader is a PyInstaller binary that injects its bundled libs via
# LD_LIBRARY_PATH (a /tmp/_MEI… dir) and possibly LD_PRELOAD. Those leak into any
# shell we spawn (e.g. `su deck -c …xprop…`), so /usr/bin/bash loads Decky's
# incompatible libreadline and dies ("undefined symbol: rl_trim_arg_from_keyseq").
# Restore each var from its PyInstaller-saved <VAR>_ORIG, else drop it.
_PYI_VARS = ("LD_LIBRARY_PATH", "LD_PRELOAD", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES")


def _clean_env():
    env = os.environ.copy()
    for var in _PYI_VARS:
        orig = env.get(var + "_ORIG")
        if orig is not None:
            env[var] = orig
        else:
            env.pop(var, None)
    return env


def _flatpak(args, capture=True):
    return subprocess.run(["flatpak"] + args, capture_output=capture, text=True,
                          env=_clean_env())


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


FLATHUB_REPO = "https://flathub.org/repo/flathub.flatpakrepo"


def ensure_installed():
    """Install (or update) the Sunshine flatpak from flathub, system scope.

    Self-sufficient on a fresh machine: ensures the flathub system remote exists
    first (no-op if already configured), then installs from it explicitly so the
    install never depends on remote state another tool happened to leave behind."""
    if is_installed():
        return True, "Sunshine already installed"
    try:
        # Guarantee the flathub system remote exists before installing from it.
        subprocess.run(
            ["flatpak", "remote-add", "--if-not-exists", "--system", "flathub", FLATHUB_REPO],
            capture_output=True, text=True, env=_clean_env(),
        )
        res = _flatpak(["install", "--system", "--noninteractive", "--or-update",
                        "flathub", APP_ID])
    except OSError as e:
        return False, "flatpak not available: %s" % e
    if res.returncode == 0:
        return True, "Sunshine installed"
    return False, (res.stderr or res.stdout or "install failed").strip()[:300]


def update():
    """Update the installed Sunshine flatpak to the latest on flathub."""
    if not is_installed():
        return False, "Sunshine is not installed"
    try:
        subprocess.run(
            ["flatpak", "remote-add", "--if-not-exists", "--system", "flathub", FLATHUB_REPO],
            capture_output=True, text=True, env=_clean_env(),
        )
        res = _flatpak(["update", "--system", "--noninteractive", APP_ID])
    except OSError as e:
        return False, "flatpak not available: %s" % e
    if res.returncode == 0:
        return True, "Sunshine updated"
    return False, (res.stderr or res.stdout or "update failed").strip()[:300]


def _parse_info(args):
    """Run `flatpak <args>` and parse its 'Key: value' output into a dict."""
    out = {}
    try:
        res = subprocess.run(["flatpak"] + args, capture_output=True, text=True,
                             env=_clean_env())
    except OSError:
        return out
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
    try:
        subprocess.run(
            ["flatpak", "remote-add", "--if-not-exists", "--system", "flathub", FLATHUB_REPO],
            capture_output=True, text=True, env=_clean_env(),
        )
    except OSError:
        pass
    inst = is_installed()
    local = _parse_info(["info", "--system", APP_ID]) if inst else {}
    remote = _parse_info(["remote-info", "--system", "flathub", APP_ID])
    ic, lc = local.get("commit", ""), remote.get("commit", "")
    return {
        "installed": inst,
        "installedVersion": local.get("version", ""),
        "latestVersion": remote.get("version", ""),
        "updateAvailable": bool(inst and ic and lc and ic != lc),
    }


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
    """Launch Sunshine in the Game-Mode session. Returns (ok, message).

    Does NOT auto-install — installation is opt-in via Settings → Sunshine."""
    if is_running():
        return True, "Sunshine already running"
    if not is_installed():
        return False, "Sunshine is not installed — install it in Settings → Sunshine"
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
                             capture_output=True, text=True, env=_clean_env())
    except OSError as e:
        return False, "could not set composition: %s" % e
    if res.returncode == 0:
        return True, "composition forced %s" % ("on" if enabled else "off")
    return False, (res.stderr or "xprop failed").strip()[:200]


def get_composition():
    """Return True if GAMESCOPE_COMPOSITE_FORCE is currently set nonzero on :0."""
    cmd = "DISPLAY=:0 xprop -root GAMESCOPE_COMPOSITE_FORCE"
    try:
        res = subprocess.run(["su", SESSION_USER, "-c", cmd],
                             capture_output=True, text=True, env=_clean_env())
    except OSError:
        return False
    out = (res.stdout or "").strip()
    if "=" not in out:  # "...: not found." when the atom is unset
        return False
    try:
        return int(out.rsplit("=", 1)[1].strip()) != 0
    except ValueError:
        return False


def apply_composition(mode):
    """Apply a composition action: 'on' | 'off' | 'toggle'. Toggle flips the
    current atom value. Returns (ok, message)."""
    mode = (mode or "on").lower()
    if mode == "toggle":
        enabled = not get_composition()
    elif mode == "off":
        enabled = False
    else:
        enabled = True
    return set_composition(enabled)


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


def basic_header(username, password):
    return base64.b64encode(("%s:%s" % (username, password)).encode()).decode()


def _api(path, method="GET", auth=None, body=None):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(WEB_BASE + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if auth:
        req.add_header("Authorization", "Basic " + auth)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=8) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def _ok_status(resp):
    return '"status":true' in (resp or "").replace(" ", "")


def _clear_login():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    # Keep everything (incl. paired devices under "root"); only drop the login.
    for k in ("username", "salt", "password"):
        data[k] = ""
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)


def set_login(username, password):
    """Set Sunshine's admin login to the given credentials, without needing the
    old password (clears the login -> first-run -> sets it). Existing paired
    devices are preserved. Returns (ok, message, auth_header)."""
    if not username or not password:
        return False, "username and password are required", None
    _clear_login()
    ok, msg = restart()
    if not ok:
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
    return False, "couldn't set login (HTTP %s)" % code, None


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
