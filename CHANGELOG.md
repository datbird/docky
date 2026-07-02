# Changelog

All notable changes to Docky are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.3.0] — 2026-07-02

### Added
- **Self-healing Sunshine discovery (mDNS).** Moonlight finds a host by browsing
  for its `_nvstream` mDNS record, which Sunshine registers only once at startup.
  On SteamOS that registration silently fails in two common cases — a boot race
  (Sunshine starts before avahi is ready) and avahi restarting later (a system
  update or DHCP/network change), both of which drop the record with no error —
  leaving Moonlight showing "host offline" while Sunshine is otherwise healthy.
  Docky now guarantees discovery: it enables and configures avahi publishing,
  verifies after startup that the record actually landed and re-registers if it
  didn't, and runs a lightweight watchdog that re-registers within seconds if the
  record ever disappears. It never interrupts a live stream.
- **HDR toggle (Game Mode).** A new **"HDR (Game Mode)"** panel toggle and a
  **"Display: HDR on/off"** task, mirroring the existing composition control. The
  gamescope HDR atom is runtime-only and resets each reboot, so Docky persists the
  preference and re-applies it on boot. The toggle reflects the live HDR state.

## [1.2.1] — 2026-06-29

### Fixed
- "Hand control back to SteamOS" now shows a toast confirmation. The action
  always worked, but its only feedback was the faint inline status line far from
  the button — and with nothing being enforced there's no visible hardware
  change — so it looked like nothing happened.

## [1.2.0] — 2026-06-29

### Added
- **Sunshine watchdog**: when Docky owns Sunshine (integrated engine), a
  background watchdog relaunches it automatically if it crashes, so a streaming
  host failure recovers on its own instead of staying down. It honors an explicit
  Stop from the panel and backs off after repeated failures. New **"Keep Sunshine
  running"** toggle (default on).
- **Persistent force-composition**: the "fix stretched image when docked" setting
  is now remembered and re-applied on boot and on every Sunshine start. The
  underlying gamescope composition atom is runtime-only and resets each reboot, so
  Docky persists the preference and reasserts it. New **"Fix stretched image when
  docked"** toggle in the Sunshine panel.

### Fixed
- Reap the detached Sunshine launch process so repeated (re)launches no longer
  leave defunct `bwrap` helper processes behind.

## [1.1.0] — 2026-06-24

### Added
- **Fan control engine** (Fantastic-style, original implementation): temperature →
  RPM **curve** with optional interpolation, **manual** fixed RPM, or **auto**
  (SteamOS). A background loop enforces curve/manual and is resume-safe; it stops
  `jupiter-fan-control` only while Docky owns the fan and hands it back on unload.
- **TDP control** in the panel: set watts directly, plus an optional **"Keep
  enforced"** toggle that re-applies the cap so Steam's slider can't override it.
- **Fan and TDP profiles**: named presets, built in the editor's new **Fan** and
  **TDP** tabs (curve editor with a live graph), applied from the panel, a task,
  or a mode. New `fanProfile`/`tdpProfile` task fields reference them.
- **"Hand control back to SteamOS"**: one panel button (and a `release_control`
  task) that returns the fan to auto and lifts the TDP cap to default.
- Panel gained collapsible **Fan** and **TDP** sections (live temp/RPM/watts
  readouts, quick mode buttons, profile dropdowns), default collapsed.

### Changed
- The `fan` and `tdp` tasks now take a saved-profile selector (TDP keeps a
  custom-watts fallback).

### Fixed
- Replaced DFL's `SliderField` with a gamepad-friendly stepper built only from
  components guaranteed present in the runtime decky-frontend-lib global.

### Performance
- Cut the `get_state` poll cost: memoized hwmon path resolution (was re-globbing
  `/sys/class/hwmon` ~5× per poll), switched PCSX2 detection from a full `/proc`
  walk to a cached `pgrep`, and the fan loop now probes `jupiter-fan-control`
  with `systemctl` only on entry / every ~10s instead of every 2s.
- Prune old PCSX2 pad-profile backups (keep the latest 5) so they don't
  accumulate on every dock/undock.

### Notes
- Requires Decky Loader **3.2.5+** (3.2.6 recommended) for the June 2026 Steam UI
  update; older Decky mis-renders all plugin panels.

## [1.0.0] — 2026-06-24

First public release. Docky evolved from a single-purpose "RetroDECK Pad
Profiles" plugin into a general Steam Deck automation tool.

### Added
- **Tasks → Actions → Modes** model with an in-Game-Mode editor (no config-file
  editing required).
- **Triggers**: dock/undock, AC power connect/disconnect, external-controller
  connect/disconnect, resume-from-sleep, and startup — each with its own toggle
  and mode mapping. Configurable dock detection (display / AC / USB hub).
- **Built-in dock fixes**: `audio_output`, `builtin_controller`, `tdp`,
  `pcsx2_profile`, `flatpak_update`.
- **Favorites**: pin actions/modes to the panel with live on/off status LEDs for
  stateful tasks, and verb-labeled buttons (On/Off/Toggle).
- **Sunshine**: full integrated management (install/update from Flathub,
  start/stop/restart, encoder, force composition, Moonlight pairing/enable/unpair)
  with selectable engine (Auto / Integrated / decky-sunshine / Off) and
  start-at-boot.
- Generic tasks: `copy`, `move`, `symlink`, `write`, `delete`, `bash`, `python`,
  `run`.

### Security / robustness
- Backend runs as root with owner-preservation on created files; script tasks run
  with a sanitized environment.
- Sunshine's setuid-root capture helper lives in a root-owned path
  (`/var/lib/docky`).
- Serialized state writes, subprocess timeouts, and corrupt-config recovery.

[1.1.0]: https://github.com/datbird/docky/releases/tag/v1.1.0
[1.0.0]: https://github.com/datbird/docky/releases/tag/v1.0.0
