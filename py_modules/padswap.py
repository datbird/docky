"""
Core logic for RetroDECK Pad Profiles.

Applies a PCSX2 "input profile" (config/PCSX2/inputprofiles/<name>.ini) to the
active config (config/PCSX2/inis/PCSX2.ini) by replacing ONLY the input-related
sections that the profile defines, leaving every other section (graphics, BIOS,
folders, ...) byte-for-byte untouched.

No external deps -> importable/testable with plain python3.
"""

import os
import re
import glob
import time
import threading
import subprocess

from sysenv import clean_env as _clean_env  # strip Decky's PyInstaller LD_LIBRARY_PATH

# RetroDECK PCSX2 config root (Flatpak) — the default install location. Kept as
# constants so configure() can RETURN to them: clearing the profiles-dir
# override in the editor calls configure(None), and without a default to restore
# padswap would stay pointed at the old custom path for the life of the process.
_DEFAULT_PCSX2_DIR = os.path.expanduser(
    "~/.var/app/net.retrodeck.retrodeck/config/PCSX2"
)
_DEFAULT_PROFILES_DIR = os.path.join(_DEFAULT_PCSX2_DIR, "inputprofiles")

PCSX2_DIR = _DEFAULT_PCSX2_DIR
MAIN_INI = os.path.join(PCSX2_DIR, "inis", "PCSX2.ini")
PROFILES_DIR = _DEFAULT_PROFILES_DIR


def configure(profiles_dir=None):
    """Point padswap at a specific PCSX2 install (for non-RetroDECK setups).

    `profiles_dir` is the folder holding the input-profile .ini files. The main
    PCSX2.ini is found as a sibling (../inis/PCSX2.ini), which matches PCSX2's
    standard layout across install types. Passing None/empty restores the
    RetroDECK default (it used to return early, which meant an override could be
    set but never cleared).
    """
    global PCSX2_DIR, MAIN_INI, PROFILES_DIR
    if not profiles_dir:
        PROFILES_DIR = _DEFAULT_PROFILES_DIR
        PCSX2_DIR = _DEFAULT_PCSX2_DIR
    else:
        # normpath so a trailing slash doesn't make dirname() return the dir itself.
        PROFILES_DIR = os.path.normpath(os.path.expanduser(profiles_dir))
        PCSX2_DIR = os.path.dirname(PROFILES_DIR)
    MAIN_INI = os.path.join(PCSX2_DIR, "inis", "PCSX2.ini")


_SECTION_RE = re.compile(r"^\[([^\]]+)\]\s*$")


# ---------- INI block parsing (format-preserving) ----------

def parse_blocks(text):
    """Return (preamble_lines, [[name, body_lines], ...]) preserving order/text."""
    preamble = []
    blocks = []
    cur = None
    for ln in text.splitlines(keepends=True):
        m = _SECTION_RE.match(ln)
        if m:
            cur = [m.group(1), []]
            blocks.append(cur)
        elif cur is None:
            preamble.append(ln)
        else:
            cur[1].append(ln)
    return preamble, blocks


def render_blocks(preamble, blocks):
    out = list(preamble)
    for name, body in blocks:
        # Bodies are built with keepends=True, so every line carries its own
        # newline — except, possibly, the file's very last one. That last body is
        # exactly what build_applied_text() appends new sections after, so
        # without this guard a PCSX2.ini lacking a trailing newline renders as
        # "LastKey=value[Hotkeys]" and the config is corrupt.
        if out and not out[-1].endswith("\n"):
            out.append("\n")
        out.append("[%s]\n" % name)
        out.extend(body)
    return "".join(out)


def section_kv(body_lines):
    """Parse 'key = value' lines into a dict (order/whitespace/blank insensitive)."""
    kv = {}
    for ln in body_lines:
        s = ln.strip()
        if not s or s.startswith(("#", ";")):
            continue
        if "=" in s:
            k, v = s.split("=", 1)
            kv[k.strip()] = v.strip()
    return kv


# ---------- apply ----------

def build_applied_text(main_text, profile_text):
    """Return new PCSX2.ini text with the profile's sections substituted in."""
    pre, mblocks = parse_blocks(main_text)
    _, pblocks = parse_blocks(profile_text)
    pmap = {n: b for n, b in pblocks}
    mnames = {n for n, _ in mblocks}
    for blk in mblocks:
        if blk[0] in pmap:
            blk[1] = pmap[blk[0]]            # replace input section body
    for n, b in pblocks:                     # append profile sections missing from main
        if n not in mnames:
            mblocks.append([n, b])
    return render_blocks(pre, mblocks)


# ---------- discovery / status ----------

def list_profiles():
    """Profile names (basenames without .ini), sorted. Empty if the dir is gone —
    glob returns [] for a missing directory rather than raising."""
    return [os.path.splitext(os.path.basename(p))[0]
            for p in sorted(glob.glob(os.path.join(PROFILES_DIR, "*.ini")))]


def _read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def profile_path(name):
    return os.path.join(PROFILES_DIR, name + ".ini")


# Profile-only meta keys that PCSX2 does not write into the global config.
IGNORE_KEYS = {"UseProfileHotkeyBindings"}


def _main_kv():
    """{section: {key: value}} for the live PCSX2.ini. Raises OSError."""
    _, mblocks = parse_blocks(_read(MAIN_INI))
    return {n: section_kv(b) for n, b in mblocks}


def _read_profiles():
    """{name: blocks} for every profile, each file read and parsed exactly ONCE.

    The reason this exists: get_state() used to compute `active`, `suggested`,
    and `devices` independently, so every profile was read four times over and
    MAIN_INI was re-read and re-parsed once per profile inside active_profile().
    At five profiles that's ~25 reads and ~25 parses to produce something
    derivable from six."""
    idx = {}
    for name in list_profiles():
        try:
            _, blocks = parse_blocks(_read(profile_path(name)))
        except OSError:
            continue  # deleted between the glob and the read
        idx[name] = blocks
    return idx


def _matches_from(pblocks, main_kv):
    """Subset match of parsed profile blocks against a parsed main ini."""
    for n, b in pblocks:
        msec = main_kv.get(n)
        if msec is None:
            return False
        for k, v in section_kv(b).items():
            if k in IGNORE_KEYS:
                continue
            if msec.get(k) != v:
                return False
    return True


def profile_matches_active(name):
    """True if every binding the profile defines is currently in effect.

    Subset match: each profile key (minus profile-only meta keys) must equal the
    main ini's value for the same section. The live config may carry extra keys
    (e.g. Hotkeys ZoomIn/ZoomOut) - those don't disqualify a match.
    """
    try:
        _, pblocks = parse_blocks(_read(profile_path(name)))
        main_kv = _main_kv()
    except OSError:
        return False
    return _matches_from(pblocks, main_kv)


def active_profile(profiles=None):
    """Name of the profile currently in effect, or None.

    `profiles` is an optional {name: blocks} index from _read_profiles(); pass it
    when you've already read them. Either way MAIN_INI is parsed ONCE here rather
    than once per candidate."""
    try:
        main_kv = _main_kv()
    except OSError:
        return None
    idx = _read_profiles() if profiles is None else profiles
    for name in sorted(idx):
        if _matches_from(idx[name], main_kv):
            return name
    return None


def _primary_device_from(blocks):
    for n, body in blocks:
        if n == "Pad1":
            m = re.search(r"(SDL-\d+)", "".join(body))
            return m.group(1) if m else None
    return None


def profile_primary_device(name):
    """Best-effort: which SDL device [Pad1] points at, e.g. 'SDL-1'. For UI hints."""
    try:
        _, blocks = parse_blocks(_read(profile_path(name)))
    except OSError:
        return None
    return _primary_device_from(blocks)


def external_display_connected():
    """An external (non-eDP) display connector reports 'connected'."""
    for p in glob.glob("/sys/class/drm/*/status"):
        conn = p.split("/")[-2]            # cardX-DP-1, cardX-eDP-1, ...
        if "eDP" in conn:
            continue
        try:
            with open(p) as f:
                if f.read().strip() == "connected":
                    return True
        except OSError:
            pass
    return False


def ac_present():
    """External power applied (any power_supply '/online' == 1). Caveat: a plain
    wall charger counts too, not only a dock."""
    for p in glob.glob("/sys/class/power_supply/*/online"):
        try:
            with open(p) as f:
                if f.read().strip() == "1":
                    return True
        except OSError:
            pass
    return False


def usb_hub_present():
    """A non-root USB hub is attached (bDeviceClass 09 on a downstream device).
    On the Deck, internal peripherals hang directly off the root hubs (usbN), so
    a *downstream* hub (name like '1-1', '2-1') means an external hub / dock is
    plugged in."""
    for d in glob.glob("/sys/bus/usb/devices/*"):
        name = os.path.basename(d)
        if "-" not in name or ":" in name:   # skip root hubs (usbN) and interfaces
            continue
        try:
            with open(os.path.join(d, "bDeviceClass")) as f:
                if f.read().strip() == "09":
                    return True
        except OSError:
            pass
    return False


# Back-compat alias: bare is_docked() == the external-display check.
def is_docked():
    return external_display_connected()


_pcsx2_lock = threading.Lock()
_pcsx2_cache = (-1e9, False)
_PCSX2_TTL = 2.0


def pcsx2_running():
    """Whether a PCSX2 process is running. Uses `pgrep` (one fast fork) with a
    short TTL cache instead of walking all of /proc — this is on the state-poll
    hot path (every 1.5–4s) and the old scan opened hundreds of files per call.

    env=_clean_env() is NOT optional. Decky injects a PyInstaller
    LD_LIBRARY_PATH that makes system binaries load Decky's incompatible libs and
    die at load time ("libcrypto.so.3: version OPENSSL_3.4.0 not found"). That
    error goes to stderr — which is DEVNULL here — and the process exits
    non-zero, which is indistinguishable from pgrep's honest "found nothing".
    So a poisoned env silently pins this to False, which disables apply_profile's
    "PCSX2 is running, close it first" guard and lets Docky rewrite PCSX2.ini
    under a live PCSX2 that will flush its in-memory config back over the edit on
    exit. Every other exec in this codebase cleans the env — including docky's own
    pgrep call — and this was the one that didn't."""
    global _pcsx2_cache
    with _pcsx2_lock:
        ts, val = _pcsx2_cache
        now = time.monotonic()
        if (now - ts) < _PCSX2_TTL:
            return val
        try:
            # No -x: match the process name *containing* "pcsx2" (e.g. pcsx2-qt),
            # case-insensitive — same semantics as the old /proc/<pid>/comm scan.
            val = subprocess.run(["pgrep", "-i", "pcsx2"], timeout=5,
                                 stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL,
                                 env=_clean_env()).returncode == 0
        except (OSError, subprocess.SubprocessError):
            val = False
        _pcsx2_cache = (now, val)
        return val


def _suggest(profiles, devices, docked):
    """Pure half of suggested_profile(), so callers that already have the device
    map don't re-read every profile to rebuild it."""
    external = [p for p in profiles if (devices.get(p) or "SDL-0") != "SDL-0"]
    internal = [p for p in profiles if (devices.get(p) or "SDL-0") == "SDL-0"]
    if docked and external:
        return external[0]
    if not docked and internal:
        return internal[0]
    return None


def suggested_profile():
    """Heuristic: docked -> profile whose Pad1 != SDL-0 (external); else SDL-0.

    Builds the device map once. It used to call profile_primary_device() inside
    two separate comprehensions — 2N file reads to partition a list it could
    partition from one pass."""
    idx = _read_profiles()
    names = sorted(idx)
    devices = {n: _primary_device_from(b) for n, b in idx.items()}
    return _suggest(names, devices, is_docked())


# ---------- mutation ----------

def apply_profile(name, force=False):
    """Swap the profile into PCSX2.ini. Returns (ok, message)."""
    if name not in list_profiles():
        return False, "Profile '%s' not found." % name
    if not os.path.isfile(MAIN_INI):
        return False, "PCSX2.ini not found - launch a PS2 game once first."
    if pcsx2_running() and not force:
        return False, "PCSX2 is running - close the game first (it overwrites the config on exit)."

    if profile_matches_active(name):
        return True, "'%s' is already active - no change." % name

    try:
        main_text = _read(MAIN_INI)
        profile_text = _read(profile_path(name))
    except OSError as e:
        return False, "Could not read config: %s" % e
    new_text = build_applied_text(main_text, profile_text)

    # capture original mode + ownership so we can restore them after writing
    # (defends against Decky running the backend as root: PCSX2 must stay able
    #  to rewrite its own ini as user 'deck').
    try:
        sres = os.stat(MAIN_INI)
        mode = sres.st_mode & 0o777
        uid, gid = sres.st_uid, sres.st_gid
    except OSError:
        mode, uid, gid = 0o600, -1, -1

    # Milliseconds, not just seconds: a mode with two pcsx2_profile tasks (or a
    # fast dock/undock) applies twice within the same second and the second
    # backup would overwrite the first. Zero-padded, so these still sort
    # chronologically for the prune below.
    now = time.time()
    stamp = "%s.%03d" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(now)),
                         int(now * 1000) % 1000)
    backup = MAIN_INI + ".bak-padprofile-" + stamp
    try:
        with open(backup, "w", encoding="utf-8") as f:
            f.write(main_text)
        # Same reason as the main ini below: written by a root backend into the
        # deck user's config dir, so hand it back or the user ends up with
        # root-owned files they can't touch.
        _restore_owner(backup, mode, uid, gid)
    except OSError as e:
        return False, "Could not write backup: %s" % e

    # atomic write, preserve mode
    tmp = MAIN_INI + ".tmp-padprofile"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new_text)
        _restore_owner(tmp, mode, uid, gid)
        os.replace(tmp, MAIN_INI)
    except OSError as e:
        return False, "Could not write PCSX2.ini: %s" % e

    # Keep only the most recent few backups so they don't accumulate forever
    # (a profile is written on every dock/undock). Stamps sort chronologically.
    try:
        baks = sorted(glob.glob(MAIN_INI + ".bak-padprofile-*"))
        for old in baks[:-5]:
            os.remove(old)
    except OSError:
        pass

    return True, "Applied '%s'. Backup: %s" % (name, os.path.basename(backup))


def _restore_owner(path, mode, uid, gid):
    """Give a file we just created the original ini's mode and ownership.
    chmod failures propagate (the caller reports them); chown is best-effort —
    it fails when we AREN'T root and therefore can't reassign ownership, in
    which case the file already belongs to the right user anyway."""
    os.chmod(path, mode)
    if uid != -1:
        try:
            os.chown(path, uid, gid)
        except OSError:  # PermissionError is an OSError
            pass


def get_state():
    """Full snapshot for the standalone Pad Profiles UI.

    NOTE: as far as I can tell nothing in Docky calls this — docky.py uses
    list_profiles/pcsx2_running/apply_profile/configure and the sysfs probes
    directly. Kept for the upstream plugin. Now reads each profile once and
    MAIN_INI once, instead of globbing four times and reading every profile four
    times over."""
    idx = _read_profiles()
    names = sorted(idx)
    devices = {n: _primary_device_from(b) for n, b in idx.items()}
    docked = is_docked()
    return {
        "config_found": os.path.isfile(MAIN_INI),
        "profiles": names,
        "active": active_profile(idx),
        "suggested": _suggest(names, devices, docked),
        "docked": docked,
        "pcsx2_running": pcsx2_running(),
        "devices": devices,
    }
