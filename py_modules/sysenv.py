"""Shared subprocess-environment helper for Docky's root backend."""

import os

# Decky's plugin_loader is a PyInstaller binary that injects its bundled libs via
# LD_LIBRARY_PATH (a /tmp/_MEI… dir) and possibly LD_PRELOAD. Those leak into any
# binary we shell out to — e.g. /usr/bin/bash then loads Decky's incompatible
# libreadline and dies ("undefined symbol: rl_trim_arg_from_keyseq"). Restore each
# from its PyInstaller-saved <VAR>_ORIG, else drop it so system binaries use system
# libraries.
_PYI_VARS = ("LD_LIBRARY_PATH", "LD_PRELOAD", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES")


def clean_env():
    env = os.environ.copy()
    for var in _PYI_VARS:
        orig = env.get(var + "_ORIG")
        if orig is not None:
            env[var] = orig
        else:
            env.pop(var, None)
    return env
