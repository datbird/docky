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

# RetroDECK PCSX2 config root (Flatpak)
PCSX2_DIR = os.path.expanduser(
    "~/.var/app/net.retrodeck.retrodeck/config/PCSX2"
)
MAIN_INI = os.path.join(PCSX2_DIR, "inis", "PCSX2.ini")
PROFILES_DIR = os.path.join(PCSX2_DIR, "inputprofiles")

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
    try:
        names = []
        for p in sorted(glob.glob(os.path.join(PROFILES_DIR, "*.ini"))):
            names.append(os.path.splitext(os.path.basename(p))[0])
        return names
    except OSError:
        return []


def _read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def profile_path(name):
    return os.path.join(PROFILES_DIR, name + ".ini")


# Profile-only meta keys that PCSX2 does not write into the global config.
IGNORE_KEYS = {"UseProfileHotkeyBindings"}


def profile_matches_active(name):
    """True if every binding the profile defines is currently in effect.

    Subset match: each profile key (minus profile-only meta keys) must equal the
    main ini's value for the same section. The live config may carry extra keys
    (e.g. Hotkeys ZoomIn/ZoomOut) - those don't disqualify a match.
    """
    try:
        _, pblocks = parse_blocks(_read(profile_path(name)))
        _, mblocks = parse_blocks(_read(MAIN_INI))
    except OSError:
        return False
    mmap = {n: section_kv(b) for n, b in mblocks}
    for n, b in pblocks:
        msec = mmap.get(n)
        if msec is None:
            return False
        for k, v in section_kv(b).items():
            if k in IGNORE_KEYS:
                continue
            if msec.get(k) != v:
                return False
    return True


def active_profile():
    for name in list_profiles():
        if profile_matches_active(name):
            return name
    return None


def profile_primary_device(name):
    """Best-effort: which SDL device [Pad1] points at, e.g. 'SDL-1'. For UI hints."""
    try:
        _, blocks = parse_blocks(_read(profile_path(name)))
    except OSError:
        return None
    for n, body in blocks:
        if n == "Pad1":
            m = re.search(r"(SDL-\d+)", "".join(body))
            return m.group(1) if m else None
    return None


def is_docked():
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


def pcsx2_running():
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/%s/comm" % pid) as f:
                if "pcsx2" in f.read().strip().lower():
                    return True
        except OSError:
            pass
    return False


def suggested_profile():
    """Heuristic: docked -> profile whose Pad1 != SDL-0 (external); else SDL-0."""
    profs = list_profiles()
    docked = is_docked()
    external = [p for p in profs if (profile_primary_device(p) or "SDL-0") != "SDL-0"]
    internal = [p for p in profs if (profile_primary_device(p) or "SDL-0") == "SDL-0"]
    if docked and external:
        return external[0]
    if not docked and internal:
        return internal[0]
    return None


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

    main_text = _read(MAIN_INI)
    profile_text = _read(profile_path(name))
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
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = MAIN_INI + ".bak-padprofile-" + stamp
    try:
        with open(backup, "w", encoding="utf-8") as f:
            f.write(main_text)
    except OSError as e:
        return False, "Could not write backup: %s" % e

    # atomic write, preserve mode
    tmp = MAIN_INI + ".tmp-padprofile"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new_text)
        os.chmod(tmp, mode)
        if uid != -1:
            try:
                os.chown(tmp, uid, gid)
            except (OSError, PermissionError):
                pass  # already correct owner (running as that user)
        os.replace(tmp, MAIN_INI)
    except OSError as e:
        return False, "Could not write PCSX2.ini: %s" % e

    return True, "Applied '%s'. Backup: %s" % (name, os.path.basename(backup))


def get_state():
    return {
        "config_found": os.path.isfile(MAIN_INI),
        "profiles": list_profiles(),
        "active": active_profile(),
        "suggested": suggested_profile(),
        "docked": is_docked(),
        "pcsx2_running": pcsx2_running(),
        "devices": {p: profile_primary_device(p) for p in list_profiles()},
    }
