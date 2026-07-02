# Development

## Layout

```
main.py                 Decky Plugin class + asyncio background watchers (triggers,
                        fan, TDP, Sunshine, mDNS) + load hooks
py_modules/
  docky.py              engine: config/state, run_task, action/mode runners,
                        triggers, favorites, sunshine-engine wrappers (no decky deps)
  sunshine.py           Sunshine flatpak control (install/launch/encoder/compose/hdr/pair)
  mdns.py               avahi/mDNS discovery healing (keeps _nvstream advertised)
  deckops.py            built-in dock fixes (audio, controller, TDP, flatpak, detect)
  padswap.py            PCSX2 input-profile logic + dock signals
  sysenv.py             shared clean_env() (strips Decky's PyInstaller LD_LIBRARY_PATH)
src/
  index.tsx             the Quick Access panel
  components/           EditorModal, PairModal, StatusModal, inputs
  taskdefs.ts           task-type table driving the add/edit forms
  util.ts               types + call()/toast()/clone() backend plumbing
dist/index.js           built frontend bundle (committed — installs need no Node)
install.sh / uninstall.sh
```

**Backend / frontend split.** The Python engine (`docky.py`) is intentionally
**decky-free and unit-testable** — `main.py` is the only file that imports
`decky`. The backend runs as **root**; `main.py` pins `HOME` to the deck user
before importing the engine so `~` resolves correctly.

## Architecture notes

- **Tasks → Actions → Modes → Triggers** are plain data in `config.json`;
  `run_task` is the dispatch table. Add a task type by adding a `run_task`
  branch + a `taskdefs.ts` entry (and a status/verb probe if it's stateful).
- **State writes are serialized** through `docky.update_state()` under a lock so
  the watcher and frontend calls can't clobber each other's fields.
- **Blocking work runs off the event loop** (`asyncio.to_thread`) — mode
  activation, `get_state`, Sunshine install/launch/pairing — so the UI stays
  responsive.
- **Subprocess calls** go through `sysenv.clean_env()` and carry timeouts so a
  hang can't freeze the root backend.

## Build & deploy on the Deck

Building the frontend needs Node + pnpm (installed locally under `~/.local` on
the dev Deck). **Build on the Deck**, not another machine.

```bash
# frontend
pnpm install          # first time
pnpm run build        # → dist/index.js
node --check dist/index.js   # sanity

# backend sanity
python3 -m py_compile main.py py_modules/*.py

# deploy + reload (rm -rf's the plugin dir, recopies, restarts the loader)
sudo ./install.sh
```

`install.sh` copies `main.py`, `plugin.json`, `package.json`, `dist/index.js`,
and **every** `py_modules/*.py` (glob — a new module can't be forgotten), chowns
root, and restarts `plugin_loader`.

### Iterating without a full reinstall

Copy only the changed file(s) into `/home/deck/homebrew/plugins/docky/` and
restart **once**: `sudo systemctl restart plugin_loader`. Avoid rapid repeated
restarts — they can leave orphaned backends holding the loader's port; if that
happens, kill leftover `Docky (...main.py)` processes by PID and
`systemctl reset-failed plugin_loader`.

## Gotchas

- **`api_version`** must be **absent** from `plugin.json` (legacy/0) — the
  frontend uses `decky-frontend-lib`'s legacy `callPluginMethod`, which Decky
  blocks at `api_version > 0`.
- **Background coroutines must be module-level**, not `Plugin` methods — Decky's
  class wrapping breaks `self.method()` calls from within the backend.
- **`dist/index.js` is committed** so fresh installs need no Node — rebuild and
  commit it with any `src/` change.
- The frontend is gamepad-navigated: wrap side-by-side button rows in
  `<Focusable flow-children="horizontal">` so the d-pad moves left/right.

For the *why* behind these and other deliberate trade-offs (root backend, fan
daemon handling, polling, the `Stepper` vs `SliderField` choice, etc.), see
[Design notes](design-notes.md) before changing them.

## Verifying

There's no automated test suite yet. Before committing:

1. `python3 -m py_compile` the backend, `node --check dist/index.js` the bundle.
2. `sudo ./install.sh`, confirm a single backend and a clean load in the
   `plugin_loader` journal.
3. Eyeball the panel in Game Mode for UI changes.
