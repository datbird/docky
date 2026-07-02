# Troubleshooting

## Docky doesn't appear in the Quick Access menu
- Confirm Decky Loader is installed and working (other plugins show up).
- Re-run `sudo ./install.sh` from the repo and watch for errors.
- Check the loader is healthy: `systemctl status plugin_loader`.
- Logs: `journalctl -u plugin_loader --since "5 min ago" | grep -i docky`.

## A trigger isn't firing
- Both halves are required: the **toggle** (panel → Triggers) *and* a **mode
  mapping** (gear → Triggers). A trigger with no mapped mode does nothing.
- Triggers baseline on enable and act on the *next* change — toggle it on, then
  cause the change.
- For **Dock**, check your detection signals (gear → Triggers → Dock). The
  default requires an external display; if your dock has no display attached,
  uncheck that and use the AC/USB-hub signals instead.

## Audio doesn't switch when docked
- Use an `audio_output` task with `target: hdmi`. If a game is already playing,
  the task moves its stream too; if an app refuses to move, the task says so.
- Some HDMI-audio failures are a Deck/firmware quirk on wake — try a
  `sunshine`-independent power-cycle of the dock, or map the **Resume** trigger
  to re-apply the audio task.

## The docked stream looks stretched / blurry
- Add a `sunshine_composition` task set to **On** to your docked mode.
- Remember `off` is permissive (not "force scanout"), so toggling off won't
  always reproduce the stretch — see [Sunshine → Composition](sunshine.md#composition-the-docked-stretch-fix).
- The fix is gamescope-version-sensitive; it's the standard workaround but not
  guaranteed on every build.

## External controller isn't Player 1 when docked
- Add a `builtin_controller` task set to **Off** to your docked mode (and **On**
  to handheld), so the built-in controller is unbound and the external pad takes
  P1.

## Settings reset after the Deck sleeps
- Map the **Resume** trigger to a Mode that re-applies the affected tasks
  (composition, audio, etc.). This is exactly what Resume is for.

## Can't connect to Sunshine / "Pair" is greyed out
- **Pair** is enabled only while Sunshine is **running**. Start it from the
  panel (Sunshine section) first; the panel refreshes and Pair enables.
- After a reboot, Sunshine comes up only if **Start Sunshine at boot** is on
  (Integrated engine) — otherwise start it manually.
- If you use `decky-sunshine`, set the engine to **Auto** (or decky-sunshine) so
  Docky doesn't fight it over the port.

## Moonlight shows the Deck as "offline" / can't find it
- This is a **discovery** (mDNS) problem, not a Sunshine one — Sunshine is
  usually running fine; Moonlight just can't see its `_nvstream` record. Docky now
  **self-heals** this: it enables avahi publishing, re-checks after boot that the
  record landed, and re-registers within seconds if avahi ever drops it. Give it a
  few seconds after a reboot and it should appear on its own. See
  [Sunshine → Staying up and discoverable](sunshine.md#staying-up-and-discoverable).
- Fallback: add the Deck by **IP** in Moonlight. Pairing survives an IP change, so
  you won't need to re-pair.
- If it's *persistently* undiscoverable, confirm avahi is alive:
  `systemctl status avahi-daemon` and `avahi-browse -rt _nvstream._tcp` (should
  list the Deck while Sunshine runs).

## HDR toggle shows "off" but my display supports HDR
- The toggle reflects the **live** gamescope HDR state, and gamescope only emits
  HDR when **Steam → Settings → Display → HDR** is on. If that's off, the toggle
  correctly reads off. A display *supporting* HDR isn't the same as HDR being
  active — turn on Steam's HDR setting (and, for a stream, enable HDR + HEVC in
  Moonlight). See [Sunshine → HDR](sunshine.md#hdr-game-mode).

## A `bash`/`run` task fails with a library/symbol error
- This was a known issue (Decky's bundled libraries leaking into shelled-out
  binaries) and is handled — Docky strips them. If you still see it, make sure
  you're on the latest build (`sudo ./install.sh`).

## Switching to Desktop Mode bounces back to Game Mode
Sunshine's KMS screen capture holds the GPU's primary DRM node (`/dev/dri/card0`),
and the KDE desktop compositor (KWin) needs that same node. If Sunshine is still
running when you switch to Desktop, KWin can't take over the GPU — the journal
shows `kwin_wayland_drm: Failed to open /dev/dri/card0 device (Device or resource
busy)` — so Plasma never starts and SteamOS drops you back to Game Mode.

**Docky handles this automatically.** When it detects you've left Game Mode
(gamescope is no longer the compositor) it releases the GPU by stopping Sunshine,
and it restarts Sunshine when you return to Game Mode — so Desktop and Moonlight
both just work. It never stops Sunshine mid-stream or while Game Mode is running.

- If a switch ever still bounces (e.g. a very fast machine wins the race), just
  try again, or stop Sunshine first from the panel (Sunshine → Stop).
- Sunshine (Game-Mode streaming) and the KDE desktop fundamentally contend for the
  GPU, so they can't both own it at once — only one runs at a time by design.

## Reset to a clean slate
- Config lives in `~/.config/docky/`. Remove `config.json` (and `state.json`) to
  start fresh; they're recreated empty on next load. Uninstalling the plugin does
  **not** delete them.
