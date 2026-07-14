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
- Turn on **"Fix stretched image when docked"** in the Sunshine panel section
  (or add a `sunshine_composition` task set to **On** to your docked mode). Once
  enabled, Docky persists it and re-applies it automatically across reboots and
  resume — you don't need to re-toggle it each boot.
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
  (audio output, controller binding, etc.). This is exactly what Resume is for.
- Composition and HDR are the exception — Docky already self-heals those atoms
  after resume, so you don't need a Resume Mode just for them.

## Can't connect to Sunshine / "Pair" is greyed out
- **Pair** is enabled only while Sunshine is **running**. Start it from the
  panel (Sunshine section) first; the panel refreshes and Pair enables.
- After a reboot, Sunshine comes up only if **Start Sunshine at boot** is on
  (Integrated engine) — otherwise start it manually.
- If you use `decky-sunshine`, set the engine to **Auto** (or decky-sunshine) so
  Docky doesn't fight it over the port.

## Moonlight connects but errors "Failed to initialize video capture/encoding" (503)
- Sunshine is running but couldn't build its screen-capture pipeline — almost
  always because the display wasn't ready when it started: a **docked boot** (the
  external screen hadn't come up yet), a **resume-from-sleep**, or a **dock/undock**
  that switched the active display. Sunshine builds capture only once at launch and
  doesn't rebuild it, so every connection then fails until it restarts.
- Docky now **self-heals** this: it watches Sunshine's capture health and, when a
  display is lit and you're not mid-stream, restarts Sunshine to rebuild capture
  against the current display — usually within ~15 seconds of the failure, or the
  moment it sees a dock/undock. Just retry Moonlight after a few seconds.
- If it *persists* after a couple of restarts, Docky backs off (a genuinely dead
  encoder or an unlit display can't be fixed by restarting): check that a display is
  actually on and awake, and that your encoder works (Sunshine panel → **Encoder**;
  VAAPI is the safe default on the Deck). See
  [Sunshine → Staying up and discoverable](sunshine.md#staying-up-and-discoverable).

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
(gamescope is no longer the compositor) it releases the GPU by immediately
SIGKILLing Sunshine, and it restarts Sunshine only once you're back in a *stable*
Game Mode — so Desktop and Moonlight both just work. It never stops Sunshine
mid-stream or while Game Mode is running.

Two safeguards make the switch reliable even when it used to bounce (fixed in
1.4.3):
- **Definitive Desktop latch.** As soon as a Plasma session appears
  (`kwin_wayland`/`plasmashell`), Docky keeps Sunshine off no matter what — a
  gamescope process that flickers during the handoff can't revive it against the
  desktop.
- **Start debounce.** Sunshine is only (re)started after gamescope has been up
  continuously for a few seconds. A bouncing switch makes gamescope flicker in and
  out as it repeatedly fails to grab the GPU (Sunshine still holds it); the
  debounce stops Docky from restarting Sunshine on each flicker, which used to
  perpetuate the bounce.

- Sunshine (Game-Mode streaming) and the KDE desktop fundamentally contend for the
  GPU, so they can't both own it at once — only one runs at a time by design.
  For *why* this is and how the whole Game-Mode ⇄ Desktop handoff works, see
  [Streaming ⇄ Desktop](gpu-coexistence.md).
- Manual escape hatch if you ever get wedged: from an SSH/terminal,
  `sudo systemctl stop plugin_loader` (halts Docky so it can't respawn Sunshine),
  `sudo pkill -x sunshine`, then `steamos-session-select plasma-wayland`. Restart
  Decky with `sudo systemctl start plugin_loader` when you go back to Game Mode.

## Steam pops "Unable to open a connection to X" after switching to Desktop
Seen on a fresh Desktop-Mode login, typically over RDP: a Steam dialog reading
"Unable to open a connection to X … make sure that you have enabled X"
(support ref `4050-WOJB-0608`). This is **not** a Docky/Sunshine fault and the
desktop is otherwise fine — it's a startup race. SteamOS autostarts the Steam
client in Desktop Mode (`/etc/xdg/autostart/steam.desktop`); when the Plasma
Wayland session is created fresh (as it is when you switch to Desktop over a
remote KRDP connection), Steam can launch a moment before Xwayland/`DISPLAY` is
answerable, lose the race, and error out. Locally you rarely see it because X is
already up by the time autostart fires.

**Docky's installer fixes this** by deploying a user-level autostart override
(`~/.config/autostart/steam.desktop`, which takes precedence over the read-only
system copy) that runs Steam through `~/.local/bin/steam-wait-x.sh`. The wrapper
polls `xdpyinfo` until X answers (30 s ceiling), then launches `steam -silent`
as normal — so Steam waits for the display instead of racing it. It only affects
Steam's *autostart*; the app-menu launcher and Game Mode are untouched.
- Already got the dialog? Just click **OK** — it's harmless, and the fix applies
  to the *next* login. To relaunch Steam now, start it from the app menu.
- To revert: `rm ~/.config/autostart/steam.desktop` (the stock system autostart
  resumes), or run `uninstall.sh`.
- This is the same Game-Mode ⇄ Desktop-over-RDP flow the GPU handoff enables — see
  [Streaming ⇄ Desktop](gpu-coexistence.md) for how the two fit together.

## Reset to a clean slate
- Config lives in `~/.config/docky/`. Remove `config.json` (and `state.json`) to
  start fresh; they're recreated empty on next load. Uninstalling the plugin does
  **not** delete them.
