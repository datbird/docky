# Changelog

All notable changes to Docky are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.4.4] — 2026-07-14

### Added
- **Steam no longer errors "Unable to open a connection to X" on a fresh Desktop-Mode
  login over RDP.** SteamOS autostarts the Steam client in Desktop Mode via
  `/etc/xdg/autostart/steam.desktop`. When the KDE Plasma (Wayland) session is spun up
  fresh — e.g. by switching to Desktop over a remote KRDP connection — Steam can launch
  before Xwayland/`DISPLAY` is answerable, lose the race, and pop its
  `4050-WOJB-0608` error dialog. `install.sh` now deploys a user-level autostart
  override (`~/.config/autostart/steam.desktop`, which wins over the read-only system
  copy) that routes Steam through `~/.local/bin/steam-wait-x.sh` — a wrapper that polls
  until X actually answers (30 s ceiling) before launching `steam -silent`. This
  complements the Desktop⇄Game GPU handoff (v1.4.3): the switch itself is already clean,
  and now the desktop that comes up doesn't greet you with a Steam error. Purely a
  desktop-session convenience; it does not touch Game Mode, the app-menu launcher, or
  the plugin runtime. Remove with `uninstall.sh` or `rm ~/.config/autostart/steam.desktop`.

## [1.4.3] — 2026-07-14

### Fixed
- **Switching to Desktop Mode no longer bounces back to Game Mode when Sunshine is
  running.** The GPU-coexistence logic keyed purely off gamescope being gone: it
  freed the GPU when gamescope exited but restarted Sunshine the instant gamescope
  reappeared. During a switch-to-Desktop that lost the race, gamescope *flickers* —
  it repeatedly tries and fails to grab `/dev/dri/card0` because Sunshine still
  holds it — and each flicker was read as "back in Game Mode," so Docky relaunched
  Sunshine mid-handoff, re-grabbed the GPU, and perpetuated the bounce (the desktop
  never stayed up, so remote RDP into the desktop was impossible). Two safeguards
  now break the oscillation:
  - **Definitive Desktop latch** — the moment a Plasma session appears
    (`kwin_wayland`/`plasmashell`), Sunshine is kept off regardless of any transient
    gamescope process, so the desktop keeps the GPU through the handoff.
  - **Start debounce** — Sunshine is only (re)started once gamescope has been
    continuously up for a few seconds (`stable_game_mode()`); stopping stays
    immediate. A flickering, bouncing transition therefore never restarts Sunshine.
  Stopping Sunshine to free the GPU is still an instant SIGKILL and still never
  interrupts a live stream or a stable Game-Mode session.

## [1.4.2] — 2026-07-05

### Fixed
- **Sunshine now self-heals "Error 503: Failed to initialize video
  capture/encoding".** Sunshine can stay *running*, responsive and discoverable
  yet be unable to capture the screen — so Moonlight connects but every stream
  fails with error 503. It builds its capture/encoder pipeline once, at launch,
  and never rebuilds it, so a display that wasn't ready at that moment wedges it
  until a restart: a **docked boot** (the external panel hadn't come up yet), a
  **resume-from-sleep**, or a **dock/undock** that swapped the active display. The
  existing watchdog only caught crashes (the process here is alive), so this could
  sit broken until noticed. Docky now judges capture health from Sunshine's own
  probe verdict and, on a definitive capture failure, a display-topology change
  (dock/undock), or resume-from-sleep, restarts Sunshine to rebuild the pipeline
  against the current display — typically within ~15 seconds. Heavily guarded: only in Game
  Mode, debounced, rate-limited, capped so an unfixable failure can't thrash, gated
  on a display actually being lit, and it never interrupts a live stream.
- **`capture = kms` is now ensured on every Sunshine start.** Launched as root in
  the Game-Mode session, Sunshine can't use the wayland/portal capture backends;
  without an explicit `capture` key it auto-picks one that fails as root (another
  path to error 503). Docky adds `capture = kms` when the key is absent, leaving a
  deliberate choice untouched.

## [1.4.1] — 2026-07-02

### Fixed
- **Force-composition / force-HDR now survive reboots reliably.** Both are
  runtime-only gamescope atoms that reset every boot, and setting them needs
  gamescope's XWayland `:0`, which isn't always up yet when the plugin loads —
  so the one-shot boot apply could lose that race and silently leave a docked
  image stretched even though the setting was remembered. Docky now retries the
  boot apply until the atoms actually take, and a lightweight watchdog reasserts
  them for the whole session, so the fix also self-heals after resume-from-sleep
  and display/mode changes. It reads before writing (no-op when already correct)
  and never touches atoms outside Game Mode.

## [1.4.0] — 2026-07-02

### Added
- **Sunshine ⇄ Desktop GPU coexistence.** Sunshine's KMS capture holds the GPU's
  primary DRM node, which blocked KWin from starting when you switched to Desktop
  Mode (the desktop would bounce straight back to Game Mode). Docky now releases
  the GPU automatically — it stops Sunshine the moment you leave Game Mode and
  restarts it when you return — so Moonlight streaming and Desktop (e.g. RDP) both
  work without manually juggling Sunshine. It never interrupts a live stream, and
  never stops Sunshine while Game Mode is running. Sunshine's autostart and
  watchdog are now Game-Mode-aware.

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
