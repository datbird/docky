# Docky

**Steam Deck automation, driven entirely from Game Mode.** Docky is a
[Decky Loader](https://decky.xyz/) plugin that runs **Actions** when something
happens — you dock, unplug AC, connect a controller, wake from sleep, or boot —
and ships built-in fixes for the common docked-mode annoyances (audio not
switching, the controller-order shuffle, the docked stretch/blur, performance).
It also fully manages [Sunshine](https://github.com/LizardByte/Sunshine) game
streaming.

Everything is built and edited in the Quick Access panel — no config files, no
Desktop Mode required.

<p align="center">
  <img src="docs/images/panel.png" alt="Docky in the Steam Deck Quick Access menu — Favorites with a live status LED" width="300">
</p>

```
Task   — one atomic operation (a built-in fix, a file op, or run a script/binary)
Action — an ordered list of Tasks
Mode   — a named set of Actions, activated manually or by a Trigger
Trigger— an event (dock/undock, AC, controller, resume, startup) → a Mode
```

---

## Highlights

- **Triggers** — run a Mode automatically on dock/undock, AC connect/disconnect,
  external-controller connect/disconnect, resume-from-sleep, or startup.
- **Built-in dock fixes** — switch audio output, disable the built-in controller
  so an external pad is Player 1, force gamescope composition (the docked
  stretch fix), and set the APU TDP — all as one-tap tasks.
- **Favorites** — pin the actions/modes you use most to the panel; stateful ones
  (like force-composition) show a live on/off LED.
- **Sunshine** — install/update from Flathub, start/stop/restart, set the
  encoder, force composition, and pair/manage Moonlight clients — or defer to the
  `decky-sunshine` plugin (auto-detected).
- **In-Game-Mode editor** — build Actions, Modes, Favorites, Triggers, and
  Sunshine settings from the gear menu; nothing persists until you Save.

## Screenshots

<table>
  <tr>
    <td valign="top" align="center">
      <img src="docs/images/triggers.png" width="240"><br>
      <sub>Triggers — run a Mode on dock / AC / controller / resume / startup</sub>
    </td>
    <td valign="top" align="center">
      <img src="docs/images/editor-actions.png" width="340"><br>
      <sub>In-Game-Mode editor (Actions / Modes / Favorites / Sunshine / Triggers)</sub>
    </td>
  </tr>
  <tr>
    <td valign="top" align="center">
      <img src="docs/images/editor-sunshine.png" width="340"><br>
      <sub>Sunshine — engine selection, version, install/update</sub>
    </td>
    <td valign="top" align="center">
      <img src="docs/images/pair.png" width="340"><br>
      <sub>Moonlight pairing & paired-device management</sub>
    </td>
  </tr>
</table>

## Install

```bash
git clone https://github.com/datbird/docky.git
cd docky
sudo ./install.sh
```

Then: Game Mode → Quick Access (•••) → Decky → **Docky**. Re-run `install.sh` to
update; `./uninstall.sh` to remove (your config is preserved). The frontend
bundle (`dist/index.js`) is committed, so a fresh clone needs **no Node
toolchain** to install. Decky Loader must already be installed.

## Quick start — a docked/handheld setup

1. Open Docky → **gear** (Settings) → **Modes** → **+ New mode**, name it
   `Docked`. Repeat for `Handheld`.
2. **Actions** → **+ New action** → add tasks, e.g. for `Docked`:
   *Audio: HDMI*, *Controller: Off (external is P1)*, *Sunshine: force
   composition → On*. Make a `Handheld` action with the inverse.
3. Assign each action to its mode (Modes tab → toggle the action on).
4. **Triggers** tab → set **When docked → `Docked`**, **When undocked →
   `Handheld`**. **Save.**
5. Back in the panel → **Triggers** section → turn on **Dock / undock**.

Dock the Deck and the `Docked` mode runs automatically. Pin either mode as a
**Favorite** for a one-tap manual switch.

## Documentation

| Guide | Covers |
|---|---|
| [Concepts](docs/concepts.md) | Tasks → Actions → Modes → Triggers → Favorites |
| [Task reference](docs/tasks.md) | Every task type, its fields, and examples |
| [Triggers](docs/triggers.md) | All triggers, dock detection, mode mapping |
| [Sunshine](docs/sunshine.md) | Engine selection, install/update, pairing, encoder, composition |
| [Configuration](docs/configuration.md) | `config.json` / `state.json` reference |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and fixes |
| [Development](docs/development.md) | Architecture, build/dev loop, deploy |

## Permissions

Docky's backend runs as **root** (`plugin.json` `flags: ["root"]`) — most of what
it does (system services, protected paths, managing other processes, the
streaming-capture helper) needs it. Files created by file-op tasks are chowned
back to their parent directory's owner so user-space can still read/edit them.
Script/command tasks therefore run as root; treat your config like a root cron.
See [Configuration → Security](docs/configuration.md#security) for details.

## Contributing

Build and dev workflow are in [docs/development.md](docs/development.md); PR notes
in [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome.

## License

[MIT](LICENSE) © datbird
