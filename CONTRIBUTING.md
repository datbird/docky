# Contributing

Issues and pull requests are welcome.

## Before you start
- Read [docs/development.md](docs/development.md) for the layout, architecture
  notes, and the build/deploy loop.
- Build the frontend **on the Steam Deck** (Node + pnpm under `~/.local`).

## Pull requests
- Keep the change focused; describe what and why.
- Backend: keep `py_modules/docky.py` (and the other engine modules)
  **decky-free** — only `main.py` imports `decky`.
- Frontend: run `pnpm run build` and **commit the rebuilt `dist/index.js`** with
  your `src/` change (installs rely on the committed bundle).
- Sanity-check before pushing:
  ```bash
  python3 -m py_compile main.py py_modules/*.py
  node --check dist/index.js
  sudo ./install.sh    # confirm a clean load in the plugin_loader journal
  ```
- Note that the backend runs as **root** — be deliberate about subprocess calls
  (use `sysenv.clean_env()` + a timeout) and filesystem ownership.

## Adding a task type
1. Add a branch in `run_task()` in `py_modules/docky.py` (and the helper in
   `deckops.py`/`sunshine.py` if it touches the OS).
2. Add an entry to `TASK_DEFS` in `src/taskdefs.ts` so it shows in the editor.
3. If it's stateful (on/off), add a `_task_bool_status` + `_task_verb` probe so
   it gets a Favorite LED.
4. Document it in [docs/tasks.md](docs/tasks.md).
