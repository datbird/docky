# Changelog

All notable changes to Docky are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] — unreleased

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

[0.1.0]: https://github.com/datbird/docky
