# Configuration

You normally never edit these by hand — the in-Game-Mode editor writes them — but
this is the reference.

## Files

| File | Holds | Touched by install? |
|---|---|---|
| `~/.config/docky/config.json` | actions, modes, favorites, trigger mappings, settings | No |
| `~/.config/docky/state.json` | active mode, trigger baselines, stored Sunshine login token | No |

Both are created on first run (config starts empty). Neither is removed by
`install.sh` / `uninstall.sh`. If `config.json` is ever unreadable/corrupt, Docky
logs a warning, moves it aside to `config.json.corrupt`, and starts from defaults
rather than silently discarding it.

## `config.json` shape

```jsonc
{
  "version": 1,
  "settings": { /* see below */ },
  "actions": {
    "<action-id>": {
      "name": "Dock setup",
      "tasks": [ { "type": "audio_output", "target": "hdmi" }, ... ],
      "continueOnError": false        // optional; default stop-on-fail
    }
  },
  "modes": {
    "<mode-id>": { "name": "Docked", "actions": ["<action-id>", ...] }
  },
  "favorites": [ { "kind": "action" | "mode", "id": "<id>" }, ... ],
  "taskSettings": { "pcsx2_profile": { "profiles_dir": "..." } },

  // Saved performance presets (built in the editor's Fan / TDP tabs).
  "fanProfiles": {
    "<id>": {
      "name": "Quiet",
      "mode": "curve",                 // "curve" | "manual" | "auto"
      "manualRpm": 3000,               // used when mode = "manual"
      "curve": {
        "interpolate": true,
        "points": [ { "temp": 45, "rpm": 0 }, { "temp": 75, "rpm": 4800 } ]
      }
    }
  },
  "tdpProfiles": { "<id>": { "name": "Docked", "watts": 20 } }
}
```

## Settings keys

| Key | Default | Meaning |
|---|---|---|
| `autoDockDetection` | `false` | enable the dock/undock trigger |
| `dockedMode` / `undockedMode` | `""` | mode to run on dock / undock |
| `requireExternalDisplay` | `true` | dock = an external display is connected |
| `requireAcPower` | `false` | (when not requiring a display) count AC as docked |
| `requireUsbHub` | `false` | (when not requiring a display) count a USB hub as docked |
| `pollSeconds` | `3` | trigger poll interval (clamped 1–3600) |
| `autoAcDetection` | `false` | enable the AC trigger |
| `acMode` / `noAcMode` | `""` | mode to run on AC / on battery |
| `autoControllerDetection` | `false` | enable the controller trigger |
| `controllerConnectMode` / `controllerDisconnectMode` | `""` | mode on connect / disconnect |
| `autoResume` | `false` | enable the resume-from-sleep trigger |
| `resumeMode` | `""` | mode to run on wake |
| `autoStartup` | `false` | enable the startup trigger |
| `startupMode` | `""` | mode to run when Docky loads |
| `sunshineEngine` | `"auto"` | `auto` / `integrated` / `decky-sunshine` / `off` |
| `autostartSunshine` | `true` | (integrated) launch Sunshine when Docky loads |
| `sunshineWatchdog` | `true` | (integrated) relaunch Sunshine automatically if it crashes |
| `forceComposition` | `false` | force gamescope composition (docked stretch fix); re-applied on boot & each Sunshine start |
| `forceHdr` | `false` | enable Game-Mode HDR; re-applied on boot & self-healed each session (atoms watchdog) |
| `fanMode` | `"auto"` | active fan mode: `auto` / `manual` / `curve` |
| `fanManualRpm` | `3000` | held RPM when `fanMode` = `manual` |
| `fanCurve` | starter curve | active curve `{ interpolate, points: [{temp,rpm}] }` |
| `fanProfile` | `""` | id of the last-applied fan profile (display only) |
| `tdpWatts` | `15` | active/last-applied TDP cap (watts) |
| `tdpEnforce` | `false` | re-apply the cap continuously (beats Steam's slider) |
| `tdpProfile` | `""` | id of the last-applied TDP profile (display only) |

`taskSettings` holds global, per-task-**type** settings (e.g. the PCSX2 profiles
folder), separate from per-task fields. `fanProfiles` / `tdpProfiles` are saved
presets (see [Performance](performance.md)); the `fan*` / `tdp*` settings above
are the *active* state the background loops enforce.

## Security

The backend runs as **root**, so:

- `bash` / `python` / `run` tasks execute **as root**. Treat your config like a
  root cron job — anything in it runs with full privileges. They run with a
  sanitized environment (Decky's bundled `LD_LIBRARY_PATH` is stripped) so system
  binaries behave normally.
- Files created by `copy` / `move` / `write` / `symlink` are chowned to their
  parent directory's owner (usually `deck`), so user-space can still edit them.
- The Sunshine capture helper is a setuid-root copy of `bwrap` kept under the
  root-owned `/var/lib/docky` (a path the unprivileged user can't tamper with).

If you don't want script execution, simply don't create `bash`/`python`/`run`
tasks — the built-in fixes and file ops cover most needs.
