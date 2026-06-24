# Docky

Steam Deck automation, runnable entirely from Game Mode via Decky Loader.

```
Task   — one atomic operation (a built-in fix, a file op, or run a script/binary)
Action — an ordered list of Tasks
Mode   — a named set of Actions, activated manually or by a trigger
```

Everything is built and edited **in the Quick Access panel** — open Docky, tap
the **gear** to edit Actions, Modes, Favorites, Sunshine, and Triggers. Pin the
actions/modes you use most as **Favorites** for one-tap access; stateful ones
(e.g. force-composition) show a live on/off LED.

> The backend runs as **root** (`plugin.json` `flags: ["root"]`). Files created
> by file-op tasks are chowned back to the owning directory's user, so
> user-space stays able to read/edit them.

## Triggers

Docky can run a Mode automatically on any of these (toggle each in the panel's
**Triggers** section, map each to a Mode in **gear → Triggers**):

| Trigger | Fires on |
|---|---|
| **Dock / undock** | external display / dock connect change |
| **AC power** | charger connect / disconnect |
| **External controller** | a real controller connects / disconnects |
| **Resume** | the Deck wakes from sleep (re-apply a Mode) |
| **Startup** | Docky loads at boot |

Dock detection is configurable (require an external display, AC power, and/or a
USB hub). Enabling a trigger baselines the current state and only acts on the
*next* change.

## Task types

Built-in **dock fixes** (from the Quick-Access editor's "Docky built-in task"
picker):

| type | does |
|---|---|
| `audio_output` | switch the default audio sink (HDMI / speakers / headphones) |
| `builtin_controller` | enable / disable / toggle the built-in controller (so an external pad owns P1 when docked) |
| `tdp` | set the APU power cap in watts (docked vs handheld performance) |
| `pcsx2_profile` | apply a PCSX2 input profile (skipped if PCSX2 is running during auto-dock) |
| `flatpak_update` | update a Flatpak app (or all) from Game Mode |
| `sunshine_start` / `sunshine_stop` / `sunshine_restart` | control Sunshine streaming |
| `sunshine_composition` | force gamescope composition On / Off / Toggle (the docked-stretch fix) |
| `sunshine_encoder` | set Sunshine's video encoder |

Generic ops:

| type | fields |
|---|---|
| `copy` / `move` | `src`, `dest` |
| `symlink` | `target`, `link`, `replace?` |
| `write` | `path`, `content`, `mode?` |
| `delete` | `path`, `recursive?` |
| `bash` / `python` | `script` **or** `path`, `args?`, `cwd?`, `timeout?` |
| `run` | `argv` (list) **or** `command` (string, shell), `cwd?`, `timeout?` |

Paths support `~` and `$VARS`. An Action runs its tasks in order; add
`"continueOnError": true` to keep going past a failed task (default: stop).

## Sunshine

Docky can fully manage [Sunshine](https://github.com/LizardByte/Sunshine)
streaming — install/update from Flathub, start/stop/restart, set the encoder,
force composition, and pair/unpair/enable Moonlight clients — or defer to the
**decky-sunshine** plugin. The **Sunshine engine** (gear → Sunshine) defaults to
**Auto**:

- **Auto** → uses decky-sunshine if it's installed, else the integrated engine
  if the Sunshine flatpak is installed, else off (not set up).
- **Integrated** — Docky owns install/launch/update.
- **decky-sunshine** — defer lifecycle to that plugin; Docky's other Sunshine
  tasks (stop, encoder, composition, pairing) still work on the shared Sunshine.
- **Off** — Docky ignores Sunshine.

## Config

`~/.config/docky/config.json` holds your actions, modes, favorites, trigger
mappings, and settings (created empty on first run — build it in the editor).
`~/.config/docky/state.json` tracks the active mode and trigger baselines.
Neither is touched by install/uninstall.

## Install

```bash
sudo ~/repos/docky/install.sh
```

Game Mode → Quick Access (•••) → Decky → **Docky**. Re-run `install.sh` to
update; `uninstall.sh` to remove. The frontend bundle (`dist/index.js`) is
committed, so a fresh clone needs no Node toolchain to install.
