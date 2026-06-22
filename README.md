# Docky

Config-driven automation for the Steam Deck, runnable from Game Mode via Decky.

```
Task   — one atomic operation (file op, run script/binary, or a built-in like a PCSX2 profile)
Action — an ordered list of Tasks
Mode   — a named set of Actions, activated manually or by auto dock detection
```

The Game-Mode UI **runs** actions, **switches** modes, and toggles **Auto Dock
Detection**. You **define** actions/modes/tasks by editing the config file
(Desktop mode) — in-UI editing is a planned follow-up (hybrid approach).

## Config

`~/.config/docky/config.json` (created with a working PCSX2 example on first run):

```json
{
  "settings": {
    "autoDockDetection": false,
    "dockedMode": "docked",
    "undockedMode": "handheld",
    "pollSeconds": 3
  },
  "actions": {
    "ps2_xbox":     { "name": "PS2: Xbox controller",  "tasks": [ {"type":"pcsx2_profile","profile":"extcontroller"} ] },
    "ps2_handheld": { "name": "PS2: built-in controls","tasks": [ {"type":"pcsx2_profile","profile":"standalone"} ] }
  },
  "modes": {
    "docked":   { "name": "Docked (TV)", "actions": ["ps2_xbox"] },
    "handheld": { "name": "Handheld",    "actions": ["ps2_handheld"] }
  }
}
```

- `settings.dockedMode` / `undockedMode` — which mode auto-dock activates on
  dock / undock. `pollSeconds` — how often the watcher checks dock state.
- A `Mode` runs its listed `actions` (in order) when activated.
- An `Action` runs its `tasks` (in order). Add `"continueOnError": true` to keep
  going past a failed task (default: stop).

## Task types

| type | fields | does |
|------|--------|------|
| `pcsx2_profile` | `profile` | apply a PCSX2 input profile (skipped if a game is running, during auto-dock) |
| `copy` | `src`, `dest` | copy a file |
| `move` | `src`, `dest` | move/rename |
| `symlink` | `target`, `link`, `replace?` | create/replace a symlink |
| `write` | `path`, `content`, `mode?` | write a text file |
| `delete` | `path`, `recursive?` | delete a file (or dir) |
| `bash` | `script` **or** `path`, `args?`, `cwd?`, `timeout?` | run bash |
| `python` | `script` **or** `path`, `args?`, `cwd?`, `timeout?` | run python3 |
| `run` | `argv` (list) **or** `command` (string, shell), `cwd?`, `timeout?` | run a binary/command |

Paths support `~` and `$VARS`. Tasks run as the **`deck`** user (the plugin has
no root flag) — for root-owned targets, call `sudo` inside a `bash`/`run` task
(requires passwordless sudo for that command).

## Auto Dock Detection

Toggle it in the panel. When ON, docking activates `dockedMode` and undocking
activates `undockedMode` automatically (a PCSX2 profile swap is skipped while a
game is actively running so it can't clobber the live config). Enabling it
baselines the current state and only acts on the *next* change.

## Install

```bash
sudo ~/repos/docky/install.sh
```

Game Mode → Quick Access (•••) → Decky → **Docky**. Re-run to update;
`uninstall.sh` to remove. Your `~/.config/docky/` is never touched by install.
