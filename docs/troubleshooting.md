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

## A `bash`/`run` task fails with a library/symbol error
- This was a known issue (Decky's bundled libraries leaking into shelled-out
  binaries) and is handled — Docky strips them. If you still see it, make sure
  you're on the latest build (`sudo ./install.sh`).

## Reset to a clean slate
- Config lives in `~/.config/docky/`. Remove `config.json` (and `state.json`) to
  start fresh; they're recreated empty on next load. Uninstalling the plugin does
  **not** delete them.
