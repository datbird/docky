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

A note on return conventions, because this module's failures are quiet ones:
every check here distinguishes "no" from "couldn't ask". A module whose whole
job is repairing a config must never report success when it couldn't read the
file, and a discovery probe must never report "not advertised" when the daemon
it asked is dead — the caller's answer to "not advertised" is to restart
Sunshine, which cannot fix a broken avahi.
"""

import os
import re
import time
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

# Both must be enabled for avahi to come back after a reboot. ensure() has
# always enabled both; only the *check* was asking about one.
AVAHI_UNITS = ("avahi-daemon.socket", "avahi-daemon.service")


def _run(args, timeout=10):
    """Run a command, swallowing OSError/timeout. Returns CompletedProcess-ish.

    Uses a cleaned env: under Decky, the injected PyInstaller LD_LIBRARY_PATH
    makes system binaries (systemctl, avahi-browse) load Decky's incompatible
    libs and fail ("libcrypto.so.3: version OPENSSL_3.4.0 not found").

    Failures come back as returncode 124 (timeout) or 127 (couldn't exec) with
    empty stdout — so callers MUST check returncode before reading stdout, or an
    unrunnable binary silently reads as an empty/negative answer."""
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                              env=_clean_env())
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", "timed out")
    except OSError as e:
        return subprocess.CompletedProcess(args, 127, "", str(e))


# `systemctl is-enabled` has several affirmative answers besides "enabled".
# "static" means the unit has no [Install] section and is pulled in by a
# dependency; "indirect" means it's enabled via another unit's Also=/alias — a
# live possibility for a socket-activated avahi. Only "disabled" both means
# "systemd won't bring it up" AND is fixable by enabling it. Treating anything
# that isn't the literal string "enabled" as needing repair is what makes
# `systemctl enable` re-run on every single call and report changed=True
# forever — which ensure_mdns() reads as "restart Sunshine to re-register".
_FIXABLE_STATES = ("disabled",)


def _disabled_units():
    """The units of AVAHI_UNITS that systemd won't start at boot and that we can
    do something about. Empty list = nothing to enable."""
    todo = []
    for unit in AVAHI_UNITS:
        r = _run(["systemctl", "is-enabled", unit])
        # is-enabled exits non-zero for "disabled" too, so returncode alone
        # can't be trusted here — go by the word it prints.
        if r.stdout.strip() in _FIXABLE_STATES:
            todo.append(unit)
    return todo


def _is_active():
    r = _run(["systemctl", "is-active", "avahi-daemon"])
    return r.stdout.strip() == "active"


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
        pub_end = len(out)  # [publish] ran to EOF
    missing = [k for k in PUBLISH_KEYS if k not in seen]
    if missing:
        changed = True
        add = ["%s=%s" % (k, PUBLISH_KEYS[k]) for k in missing]
        if pub_end is None:
            # No [publish] section at all — create one at the end.
            out += ["", "[publish]"] + add
        else:
            # Back up over the section's trailing blank lines so the new keys
            # land under the last real entry, not glued to the next header.
            while pub_end > 0 and not out[pub_end - 1].strip():
                pub_end -= 1
            out[pub_end:pub_end] = add
    return "\n".join(out) + "\n", changed


def ensure_publishing():
    """Make sure avahi is configured to publish. Returns (ok, changed, message).

    ok=False means we could NOT read or write the config, so publishing is
    almost certainly still off. That case used to be indistinguishable from
    "already correct" — both returned (False, msg) — and ensure() only surfaced
    the message when changed was True, so a read-only /etc or a moved config
    reported "already healthy" while discovery stayed dead with no log line.
    Rewriting this file is the whole point of the module; failing to must be
    loud."""
    try:
        with open(AVAHI_CONF, "r") as f:
            text = f.read()
    except OSError as e:
        return False, False, "can't read %s: %s" % (AVAHI_CONF, e)
    new_text, changed = _patch_publish(text)
    if not changed:
        return True, False, "publishing already enabled"
    try:
        # Keep a one-time backup of the stock config.
        if not os.path.exists(AVAHI_CONF + ".docky-bak"):
            with open(AVAHI_CONF + ".docky-bak", "w") as f:
                f.write(text)
        # Atomic replace, so a hard power-off mid-write can't leave a truncated or
        # empty SYSTEM config — avahi would then start with publishing off or fail
        # to start entirely, and nothing auto-restores the .docky-bak. Write a temp
        # file in the same dir, fsync it durable, preserve the original's mode, then
        # os.replace() as a single-step swap. Mirrors docky._write_json_atomic().
        try:
            mode = os.stat(AVAHI_CONF).st_mode & 0o777
        except OSError:
            mode = 0o644
        tmp = AVAHI_CONF + ".docky-tmp"
        with open(tmp, "w") as f:
            f.write(new_text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, AVAHI_CONF)
        try:
            dfd = os.open(os.path.dirname(AVAHI_CONF), os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass
    except OSError as e:
        return False, False, "can't write %s: %s" % (AVAHI_CONF, e)
    return True, True, "enabled avahi publishing"


def advertised(service=NVSTREAM_SERVICE, timeout=5):
    """Is `service` on the wire? True / False / None.

    None means we couldn't ask — avahi-daemon down, avahi-browse missing, D-Bus
    refusing us, or the browse timed out. That is NOT the same as "Sunshine
    isn't advertising", and callers must not treat it as such: the response to
    False is to restart Sunshine, and restarting Sunshine cannot fix a dead
    avahi. _run() reports those failures as returncode 124/127 with empty
    stdout, which is exactly what an honest "browsed, found nothing" also looks
    like — hence the returncode check."""
    res = _run(["avahi-browse", "-ptr", service], timeout=timeout)
    if res.returncode != 0:
        return None
    # '=' marks a RESOLVED record in parsable output. '+' would mean merely
    # announced; resolution is what Moonlight actually needs to connect, so the
    # stricter check is the honest one.
    return any(line.startswith("=") for line in res.stdout.splitlines())


def wait_advertised(timeout=6.0, interval=0.5, service=NVSTREAM_SERVICE):
    """Poll advertised() until it's True or `timeout` elapses.
    Returns True, or the last non-True answer (False = asked and it's not there,
    None = couldn't ask).

    Exists so callers stop using advertised()'s own latency as a grace window.
    A just-started Sunshine takes a beat to publish, and the settle loop that
    waits for it was relying on `avahi-browse -t` happening to block for ~1s —
    but -t terminates on AllForNow, which can return almost immediately against
    a warm cache. Four "tries" then elapse in milliseconds and Sunshine gets
    restarted two seconds before it would have published. Timing that matters
    should be a sleep."""
    deadline = time.monotonic() + timeout
    while True:
        res = advertised(service)
        if res is True:
            return True
        if time.monotonic() >= deadline:
            return res
        time.sleep(interval)


def ensure(restart_daemon=True):
    """Idempotently guarantee avahi is enabled, running, and publishing.

    Returns (ok, changed, message). `changed` is True when we had to enable the
    service, start it, or rewrite its config — the caller uses that to decide
    whether Sunshine must be restarted to (re)register its _nvstream service.
    Because `changed` costs a Sunshine restart, every step that sets it verifies
    the change actually took rather than trusting an exit code.
    """
    changed = False
    notes = []

    todo = _disabled_units()
    if todo:
        r = _run(["systemctl", "enable"] + todo)
        if r.returncode != 0:
            return False, changed, "enable failed: %s" % (r.stderr.strip() or r.stdout.strip())
        # Verify. Without this, a unit that reports something other than
        # "enabled" after a successful enable would make us re-enable and claim
        # changed=True on every call, forever.
        still = _disabled_units()
        if still:
            return False, changed, "enable reported success but %s still disabled" % ", ".join(still)
        changed = True
        notes.append("enabled " + ", ".join(todo))

    cfg_ok, cfg_changed, cfg_msg = ensure_publishing()
    if not cfg_ok:
        # Publishing off = not discoverable, full stop. Never fall through to
        # "already healthy" on the strength of the daemon merely being up.
        return False, changed, cfg_msg
    if cfg_changed:
        changed = True
        notes.append(cfg_msg)

    if not _is_active():
        r = _run(["systemctl", "start", "avahi-daemon"])
        if r.returncode != 0:
            return False, changed, "start failed: %s" % (r.stderr.strip() or r.stdout.strip())
        changed = True
        notes.append("started")
    elif cfg_changed and restart_daemon:
        # Config edits only take effect on (re)start.
        r = _run(["systemctl", "restart", "avahi-daemon"], timeout=20)
        if r.returncode != 0:
            # The config on disk is right but the running daemon is still the
            # old one, so publishing is still off. Don't report ok.
            return False, changed, "config updated but restart failed: %s" % (
                r.stderr.strip() or r.stdout.strip())
        notes.append("restarted for new config")

    return True, changed, (", ".join(notes) if notes else "already healthy")
