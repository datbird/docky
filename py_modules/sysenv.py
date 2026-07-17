"""Shared subprocess-environment helper for Docky's root backend."""

import os
import subprocess

# Decky's plugin_loader is a PyInstaller binary that injects its bundled libs via
# LD_LIBRARY_PATH (a /tmp/_MEI… dir) and possibly LD_PRELOAD. Those leak into any
# binary we shell out to — e.g. /usr/bin/bash then loads Decky's incompatible
# libreadline and dies ("undefined symbol: rl_trim_arg_from_keyseq"). Restore each
# from its PyInstaller-saved <VAR>_ORIG, else drop it so system binaries use system
# libraries.
_PYI_VARS = ("LD_LIBRARY_PATH", "LD_PRELOAD", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES")


def clean_env():
    """A copy of os.environ with PyInstaller's loader injections undone.

    Not cached: it's ~100 dict entries against a fork+exec that costs three
    orders of magnitude more, and os.environ is genuinely mutated at runtime
    (main.py pins HOME at import; sunshine reads XDG_RUNTIME_DIR live).
    """
    env = os.environ.copy()
    for var in _PYI_VARS:
        orig_key = var + "_ORIG"
        orig = env.pop(orig_key, None)
        # `if orig:` — NOT `if orig is not None:`. PyInstaller writes <VAR>_ORIG
        # whenever the original was non-NULL, and an empty-but-set
        # LD_LIBRARY_PATH is non-NULL, so a faithful restore writes "" back. To
        # the dynamic loader that is not the same as unset: an empty element in
        # LD_LIBRARY_PATH means the current directory, exactly as it does in
        # PATH. So "restoring" it would put the root backend's cwd on the
        # library search path of every binary we exec — the opposite of the
        # point. Empty and absent mean the same thing here; drop both.
        if orig:
            env[var] = orig
        else:
            env.pop(var, None)
    return env


def run(argv, **kwargs):
    """subprocess.run() with the environment already cleaned.

    Use this for anything that execs a system binary. It exists because
    clean_env() is a helper you can forget, and forgetting it is silent: the
    loader error goes to the child's stderr, the process exits non-zero, and a
    non-zero exit is indistinguishable from an honest negative answer. Both
    `pgrep` call sites in this codebase shipped without it, and neither looked
    wrong — `subprocess.run(["pgrep", ...])` reads fine right up until
    force_stop() reports "not running" and never frees /dev/dri/card0.

    With this, the mistake stops being invisible: it becomes "called
    subprocess.run directly outside sysenv", which is one grep, and one you can
    put in CI.

    Deliberately thin — no timeout/OSError swallowing. Callers have their own
    conventions for that (CompletedProcess(124) here, bool there) and this
    should stay a drop-in for subprocess.run. Pass env= explicitly to override.
    """
    if "env" not in kwargs:
        kwargs["env"] = clean_env()
    return subprocess.run(argv, **kwargs)
