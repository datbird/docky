# Task reference

Every task has a `type` plus type-specific fields. You add and configure tasks in
the editor (gear → Actions → pick an action → **Add a task**). Built-in tasks
live under the "Docky built-in task" picker; generic ops are listed directly.

Paths in any task expand `~` and `$VARS`.

## Built-in dock fixes

### `audio_output` — switch audio output
Sets the default PipeWire sink and moves currently-playing streams onto it.

| field | values |
|---|---|
| `target` | `hdmi` (external/dock), `speakers` (internal), `headphones`, or any substring of a sink name |

Fixes "audio won't switch to the TV when docked." If a playing app refuses to
move, the task reports how many streams stayed put rather than claiming success.

### `builtin_controller` — enable/disable the built-in controller
Binds or unbinds the Steam Deck's built-in controller (USB `28de:1205`) so an
external pad can own Player 1 when docked.

| field | values |
|---|---|
| `mode` | `on` (enabled), `off` (disabled), `toggle` |

Stateful — shows a live LED on a Favorite. Set **Off** in your docked mode,
**On** in handheld.

### `pcsx2_profile` — apply a PCSX2 input profile
Swaps the PCSX2 emulator's controller input profile (e.g. Xbox pad when docked
vs. built-in controls handheld). Skipped automatically if PCSX2 is running during
an auto-dock event so it can't clobber a live session.

| field | values |
|---|---|
| `profile` | name of a PCSX2 input profile |
| `force` | apply even while PCSX2 is running |

The profiles folder is configurable per-task-type (the gear next to the picker)
for non-RetroDECK installs.

### `flatpak_update` — update Flatpak app(s)
Runs `flatpak update` from Game Mode.

| field | values |
|---|---|
| `app` | a Flatpak app id, or blank for **all** |

### Sunshine tasks
See the [Sunshine guide](sunshine.md) for the full picture.

| type | does |
|---|---|
| `sunshine_start` / `sunshine_stop` / `sunshine_restart` | control the Sunshine process |
| `sunshine_composition` | force gamescope composition — `mode`: `on`/`off`/`toggle` (the docked stretch fix) |
| `sunshine_encoder` | set the video encoder — `encoder`: ``(auto)/`vaapi`/`vulkan`/`software` |

## Performance

Fan and TDP control. The panel's **Fan** and **TDP** sections drive these live;
these tasks let a Mode apply them automatically (e.g. a docked profile on dock).
See the [Performance guide](performance.md) for the full picture, the curve
editor, and building profiles.

### `fan` — apply a fan profile
Applies a saved [fan profile](performance.md#profiles) (a curve, manual RPM, or
auto), or hands the fan back to SteamOS.

| field | values |
|---|---|
| `profile` | a saved fan profile id, or `auto` (SteamOS) |

Build fan profiles in the editor's **Fan** tab. (A hand-edited config may instead
set `mode` = `auto`/`manual`/`curve` and `rpm` inline.)

### `tdp` — set the APU power cap
Applies a saved [TDP profile](performance.md#profiles), or an inline wattage.
Writes amdgpu's `power1_cap` (clamped to the device's min/max — the stock max is
15 W; higher needs an unlocked BIOS). AMD-APU only.

| field | values |
|---|---|
| `profile` | a saved TDP profile id (preferred), **or** |
| `watts` | integer, e.g. `15` |

Use a higher value docked (on AC), lower on battery. For it to *stick* against
Steam's own TDP slider, turn on **Keep enforced** in the panel's TDP section.

### `release_control` — hand control back to SteamOS
Disables all Docky hardware control: fan → Auto and the TDP cap lifted to the
hardware default (enforcement off). No fields. Handy in an "undocked" or
"handheld" mode.

## Generic operations

| type | fields | does |
|---|---|---|
| `copy` | `src`, `dest` | copy a file |
| `move` | `src`, `dest` | move/rename |
| `symlink` | `target`, `link`, `replace?` | create a symlink (replace defaults on) |
| `write` | `path`, `content`, `mode?` | write a text file (`mode` octal, e.g. `755`) |
| `delete` | `path`, `recursive?` | delete a file, or a dir with `recursive` |
| `bash` | `script` **or** `path`, `args?`, `cwd?`, `timeout?` | run a bash script |
| `python` | `script` **or** `path`, `args?`, `cwd?`, `timeout?` | run a python3 script |
| `run` | `argv` (list) **or** `command` (shell string), `cwd?`, `timeout?` | run a binary/command |

`bash`/`python`/`run` execute **as root** with a sanitized environment (Decky's
bundled library paths are stripped so system binaries behave normally). A `run`
task with neither `argv` nor `command` is an error, not a silent no-op.

## Error handling

An Action runs its tasks in order and **stops at the first failure** by default.
Set `continueOnError` on the Action (in the config) to run all tasks regardless.
Each task reports `ok`, an optional `skipped`, and a human message surfaced in the
panel.
