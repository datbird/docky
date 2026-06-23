import asyncio
import os
import pwd

import decky

# Decky runs this plugin's backend as ROOT (plugin.json flags:["root"]). Pin HOME
# to the deck user's home BEFORE importing the engine, so every "~"/expanduser it
# uses (config dir, PCSX2 paths, plugins dir, and ~ in user task paths) resolves
# to /home/deck rather than /root.
try:
    os.environ["HOME"] = os.environ.get("DECKY_USER_HOME") or pwd.getpwnam("deck").pw_dir
except KeyError:
    pass

import docky


async def _dock_watch():
    # Poll dock state; on a transition (while auto-dock is enabled) activate the
    # mapped mode. Emulator-guarded so it won't clobber a live PCSX2. Module-level
    # (NOT a Plugin method) — Decky's class wrapping breaks self.method() calls.
    while True:
        poll = 3
        try:
            cfg = docky.load_config()
            s = cfg["settings"]
            poll = max(1, int(s.get("pollSeconds", 3)))
            if s.get("autoDockDetection"):
                st = docky.load_state()
                docked = docky.is_docked(cfg)
                last = st.get("lastDock")
                if last is not None and docked != last:
                    mode = s["dockedMode"] if docked else s["undockedMode"]
                    decky.logger.info("auto-dock: %s -> mode '%s'",
                                      "docked" if docked else "undocked", mode)
                    docky.activate_mode(mode, allow_running_emu=False)
                st["lastDock"] = docked
                docky.save_state(st)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("dock watch error")
            poll = 5
        await asyncio.sleep(poll)


class Plugin:
    _watch_task = None

    # ---- frontend-callable ----

    async def get_state(self):
        try:
            return docky.get_state()
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("get_state failed")
            return {"error": str(e)}

    async def run_action(self, action_id):
        try:
            res = docky.run_action(action_id, allow_running_emu=True)
            decky.logger.info("run_action(%s) ok=%s", action_id, res.get("ok"))
            return {"result": res, "state": docky.get_state()}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("run_action failed")
            return {"result": {"ok": False, "message": str(e)}}

    async def activate_mode(self, mode_id):
        try:
            res = docky.activate_mode(mode_id, allow_running_emu=True)
            decky.logger.info("activate_mode(%s) ok=%s", mode_id, res.get("ok"))
            return {"result": res, "state": docky.get_state()}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("activate_mode failed")
            return {"result": {"ok": False, "message": str(e)}}

    async def set_auto_dock(self, enabled):
        try:
            settings = docky.set_auto_dock(enabled)
            return {"settings": settings, "state": docky.get_state()}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_auto_dock failed")
            return {"error": str(e)}

    async def set_sunshine_login(self, username, password):
        try:
            res = docky.set_sunshine_login(username, password)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_sunshine_login failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_pair(self, pin, name):
        try:
            return docky.sunshine_pair(pin, name)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_pair failed")
            return {"ok": False, "message": str(e)}

    async def get_config(self):
        try:
            return {"config": docky.load_config(), "path": docky.CONFIG_PATH}
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}

    async def save_config(self, config):
        try:
            docky.save_config(config)
            return {"ok": True, "state": docky.get_state()}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("save_config failed")
            return {"ok": False, "error": str(e)}

    # ---- lifecycle + auto-dock watcher ----

    async def _main(self):
        docky.load_config()  # ensure default exists
        self._watch_task = asyncio.create_task(_dock_watch())
        decky.logger.info("Docky loaded; config=%s", docky.CONFIG_PATH)

    async def _unload(self):
        if self._watch_task:
            self._watch_task.cancel()
        decky.logger.info("Docky unloaded")

    async def _uninstall(self):
        pass
