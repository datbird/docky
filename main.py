import asyncio
import os
import pwd
import time

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


# Transition triggers: (enable flag, state field, read-now fn, on-true mode key,
# on-false mode key, label). On each poll, an enabled trigger whose state flips
# activates the mapped mode.
_TRANSITION_TRIGGERS = [
    ("autoDockDetection", "lastDock", lambda cfg: docky.is_docked(cfg),
     "dockedMode", "undockedMode", "dock"),
    ("autoAcDetection", "lastAc", lambda cfg: docky.padswap.ac_present(),
     "acMode", "noAcMode", "AC power"),
    ("autoControllerDetection", "lastController",
     lambda cfg: docky.deckops.external_controller_present(),
     "controllerConnectMode", "controllerDisconnectMode", "controller"),
]


def _fire(mode, why):
    if not mode:
        return
    decky.logger.info("trigger %s -> mode '%s'", why, mode)
    docky.activate_mode(mode, allow_running_emu=False)


async def _trigger_watch():
    # Poll all enabled triggers; on a transition activate the mapped mode. Also
    # detect resume-from-sleep via CLOCK_BOOTTIME (counts suspend) vs MONOTONIC
    # (does not). Module-level — Decky's class wrapping breaks self.method().
    mono0 = time.monotonic()
    boot0 = time.clock_gettime(time.CLOCK_BOOTTIME)
    first = True
    while True:
        poll = 3
        try:
            cfg = docky.load_config()
            s = cfg["settings"]
            poll = max(1, int(s.get("pollSeconds", 3)))
            st = docky.load_state()

            # resume detection: boot-time advanced far more than awake time.
            # Skip the first iteration (its delta isn't a real suspend).
            mono1 = time.monotonic()
            boot1 = time.clock_gettime(time.CLOCK_BOOTTIME)
            slept = (boot1 - boot0) - (mono1 - mono0)
            mono0, boot0 = mono1, boot1
            if not first and s.get("autoResume") and slept > 20:
                _fire(s.get("resumeMode"), "resume (slept %ds)" % int(slept))
            first = False

            # Collect only the baseline fields that changed, then merge them
            # atomically — never write back the whole (stale) state object, which
            # would clobber an activeMode a fired trigger just set.
            changes = {}
            for flag, field, read, on_true, on_false, label in _TRANSITION_TRIGGERS:
                if not s.get(flag):
                    continue
                cur = read(cfg)
                last = st.get(field)
                if cur != last:
                    if last is not None:
                        _fire(s.get(on_true) if cur else s.get(on_false),
                              "%s %s" % (label, "on" if cur else "off"))
                    changes[field] = cur
            if changes:
                docky.update_state(**changes)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("trigger watch error")
            poll = 5
        await asyncio.sleep(poll)


async def _startup_trigger():
    # Run the startup mode once on load (boot), if enabled. Off the event loop
    # since it may run blocking tasks.
    try:
        cfg = docky.load_config()
        s = cfg["settings"]
        if s.get("autoStartup") and s.get("startupMode"):
            decky.logger.info("trigger startup -> mode '%s'", s["startupMode"])
            await asyncio.to_thread(docky.activate_mode, s["startupMode"], False)
    except Exception:  # noqa: BLE001
        decky.logger.exception("startup trigger failed")


async def _autostart_sunshine():
    # Start Sunshine on load (at boot) if enabled. sunshine.start() blocks while
    # waiting for the port to bind, so run it in a thread to keep _main snappy.
    # Module-level (NOT a Plugin method) — Decky's class wrapping breaks self.*.
    try:
        attempted, ok, msg = await asyncio.to_thread(docky.autostart_sunshine)
        if attempted:
            (decky.logger.info if ok else decky.logger.warning)(
                "autostart Sunshine: %s", msg)
    except Exception:  # noqa: BLE001
        decky.logger.exception("autostart Sunshine failed")


class Plugin:
    _watch_task = None
    _autostart_task = None
    _startup_task = None

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

    async def set_trigger(self, key, enabled):
        try:
            settings = docky.set_trigger(key, enabled)
            return {"settings": settings, "state": docky.get_state()}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_trigger failed")
            return {"error": str(e)}

    async def set_sunshine_login(self, username, password):
        try:
            res = docky.set_sunshine_login(username, password)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_sunshine_login failed")
            return {"ok": False, "message": str(e)}

    async def set_autostart_sunshine(self, enabled):
        try:
            docky.set_autostart_sunshine(enabled)
            return {"state": docky.get_state()}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_autostart_sunshine failed")
            return {"error": str(e)}

    # Sunshine install/update/version-check hit flatpak + the network, so run
    # them off the event loop to keep the UI responsive.
    async def sunshine_install(self):
        try:
            res = await asyncio.to_thread(docky.sunshine_install)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_install failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_update(self):
        try:
            res = await asyncio.to_thread(docky.sunshine_update)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_update failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_version_info(self):
        try:
            return await asyncio.to_thread(docky.sunshine_version_info)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_version_info failed")
            return {"error": str(e)}

    # Sunshine start/stop/restart block while waiting on the port, so run them
    # off the event loop to keep the UI responsive.
    async def sunshine_start(self):
        try:
            res = await asyncio.to_thread(docky.sunshine_start)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_start failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_stop(self):
        try:
            res = await asyncio.to_thread(docky.sunshine_stop)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_stop failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_restart(self):
        try:
            res = await asyncio.to_thread(docky.sunshine_restart)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_restart failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_pair(self, pin, name):
        try:
            return docky.sunshine_pair(pin, name)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_pair failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_clients(self):
        try:
            return docky.sunshine_clients()
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "clients": [], "message": str(e)}

    async def sunshine_unpair(self, uuid):
        try:
            return docky.sunshine_unpair(uuid)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "message": str(e)}

    async def sunshine_unpair_all(self):
        try:
            return docky.sunshine_unpair_all()
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "message": str(e)}

    async def sunshine_set_client_enabled(self, uuid, enabled):
        try:
            return docky.sunshine_set_client_enabled(uuid, enabled)
        except Exception as e:  # noqa: BLE001
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
        self._watch_task = asyncio.create_task(_trigger_watch())
        self._autostart_task = asyncio.create_task(_autostart_sunshine())
        self._startup_task = asyncio.create_task(_startup_trigger())
        decky.logger.info("Docky loaded; config=%s", docky.CONFIG_PATH)

    async def _unload(self):
        for task in (self._watch_task, self._autostart_task, self._startup_task):
            if task:
                task.cancel()
        decky.logger.info("Docky unloaded")

    async def _uninstall(self):
        pass
