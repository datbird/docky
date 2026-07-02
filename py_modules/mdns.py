"""
Docky's mDNS (avahi) resilience for Sunshine/Moonlight discovery.

Moonlight finds a host two ways: an mDNS browse for `_nvstream._tcp`, and
resolving `<host>.local`. Both need avahi to be running AND *publishing*.
SteamOS ships avahi installed but in resolve-only mode
(/etc/avahi/avahi-daemon.conf: disable-publishing=yes, publish-addresses=no,
publish-workstation=no, disable-user-service-publishing=yes), and leaves the
service disabled. The net effect: Sunshine is up and listening, yet Moonlight
can't discover it and — after any DHCP address change — a host added by IP goes
"offline" with no name fallback. That reads to the user as "Sunshine keeps
breaking" when nothing about Sunshine actually changed.

This module makes discovery self-healing: enable + start avahi, flip publishing
on, and keep it that way across reboots and SteamOS updates (which reset /etc).
It's original Docky code relying only on public platform facts (the avahi config
keys and standard systemctl/avahi-browse invocations).
"""

import re
import subprocess

from sysenv import clean_env as _clean_env  # strip Decky's PyInstaller LD_LIBRARY_PATH

AVAHI_CONF = "/etc/avahi/avahi-daemon.conf"
NVSTREAM_SERVICE = "_nvstream._tcp"

# The [publish] keys that must be on for Sunshine to be discoverable, and the
# values we enforce. SteamOS's defaults are the opposite of every one of these.
PUBLISH_KEYS = {
    "disable-publishing": "no",
    "disable-user-service-publishing": "no",
    "publish-addresses": "yes",
    "publish-workstation": "yes",
}


def _run(args, timeout=10):
    """Run a command, swallowing OSError/timeout. Returns CompletedProcess-ish.

    Uses a cleaned env: under Decky, the injected PyInstaller LD_LIBRARY_PATH
    makes system binaries (systemctl, avahi-browse) load Decky's incompatible
    libs and fail ("libcrypto.so.3: version OPENSSL_3.4.0 not found")."""
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                              env=_clean_env())
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", "timed out")
    except OSError as e:
        return subprocess.CompletedProcess(args, 127, "", str(e))


def _is_enabled():
    return _run(["systemctl", "is-enabled", "avahi-daemon"]).stdout.strip() == "enabled"


def _is_active():
    return _run(["systemctl", "is-active", "avahi-daemon"]).stdout.strip() == "active"


def _patch_publish(text):
    """Return (new_text, changed): force every PUBLISH_KEYS entry on inside the
    [publish] section. Rewrites a key whether it's set to the wrong value or
    commented out; appends any that are missing. Leaves everything else intact."""
    lines = text.splitlines()
    out = []
    section = None
    seen = set()
    changed = False
    pub_end = None  # index in `out` where [publish] ends, for appending missing keys
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if section == "publish" and pub_end is None:
                pub_end = len(out)
            section = stripped[1:-1].strip()
        m = re.match(r"^\s*#?\s*([a-z0-9-]+)\s*=", line)
        if section == "publish" and m and m.group(1) in PUBLISH_KEYS:
            key = m.group(1)
            want = "%s=%s" % (key, PUBLISH_KEYS[key])
            if line != want:
                changed = True
            out.append(want)
            seen.add(key)
            continue
        out.append(line)
    if section == "publish" and pub_end is None:
        pub_end = len(out)
    missing = [k for k in PUBLISH_KEYS if k not in seen]
    if missing:
        changed = True
        add = ["%s=%s" % (k, PUBLISH_KEYS[k]) for k in missing]
        if pub_end is None:
            # No [publish] section at all — create one at the end.
            out += ["[publish]"] + add
        else:
            out[pub_end:pub_end] = add
    return "\n".join(out) + "\n", changed


def ensure_publishing():
    """Make sure avahi is configured to publish. Returns (changed, message)."""
    try:
        with open(AVAHI_CONF, "r") as f:
            text = f.read()
    except OSError as e:
        return False, "can't read %s: %s" % (AVAHI_CONF, e)
    new_text, changed = _patch_publish(text)
    if not changed:
        return False, "publishing already enabled"
    try:
        # Keep a one-time backup of the stock config.
        import os
        if not os.path.exists(AVAHI_CONF + ".docky-bak"):
            with open(AVAHI_CONF + ".docky-bak", "w") as f:
                f.write(text)
        with open(AVAHI_CONF, "w") as f:
            f.write(new_text)
    except OSError as e:
        return False, "can't write %s: %s" % (AVAHI_CONF, e)
    return True, "enabled avahi publishing"


def advertised(service=NVSTREAM_SERVICE, timeout=5):
    """True if at least one resolved record for `service` is on the wire."""
    res = _run(["avahi-browse", "-ptr", service], timeout=timeout)
    return any(line.startswith("=") for line in res.stdout.splitlines())


def ensure(restart_daemon=True):
    """Idempotently guarantee avahi is enabled, running, and publishing.

    Returns (ok, changed, message). `changed` is True when we had to enable the
    service, start it, or rewrite its config — the caller uses that to decide
    whether Sunshine must be restarted to (re)register its _nvstream service.
    """
    changed = False
    notes = []

    if not _is_enabled():
        r = _run(["systemctl", "enable", "avahi-daemon.socket", "avahi-daemon.service"])
        if r.returncode == 0:
            changed = True
            notes.append("enabled")
        else:
            return False, changed, "enable failed: %s" % (r.stderr.strip() or r.stdout.strip())

    cfg_changed, cfg_msg = ensure_publishing()
    if cfg_changed:
        changed = True
        notes.append(cfg_msg)

    if not _is_active():
        r = _run(["systemctl", "start", "avahi-daemon"])
        if r.returncode == 0:
            changed = True
            notes.append("started")
        else:
            return False, changed, "start failed: %s" % (r.stderr.strip() or r.stdout.strip())
    elif cfg_changed and restart_daemon:
        # Config edits only take effect on (re)start.
        _run(["systemctl", "restart", "avahi-daemon"])
        notes.append("restarted for new config")

    return True, changed, (", ".join(notes) if notes else "already healthy")
