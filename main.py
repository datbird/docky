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
    # No DECKY_USER_HOME and no 'deck' user — HOME stays /root and config would
    # land under /root. Loud about it rather than silently wrong-pathing.
    decky.logger.warning("Docky: could not resolve deck home; HOME stays %s",
                         os.environ.get("HOME"))

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


async def _fire(mode, why):
    if not mode:
        return
    decky.logger.info("trigger %s -> mode '%s'", why, mode)
    # Offload the (blocking) mode activation so a long-running task can't freeze
    # the event loop — and with it every frontend RPC and the watcher itself.
    await asyncio.to_thread(docky.activate_mode, mode, allow_running_emu=False)


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
            try:
                poll = max(1, min(3600, int(s.get("pollSeconds", 3))))
            except (TypeError, ValueError):
                poll = 3
            st = docky.load_state()

            # resume detection: boot-time advanced far more than awake time.
            # Skip the first iteration (its delta isn't a real suspend).
            mono1 = time.monotonic()
            boot1 = time.clock_gettime(time.CLOCK_BOOTTIME)
            slept = (boot1 - boot0) - (mono1 - mono0)
            mono0, boot0 = mono1, boot1
            if not first and s.get("autoResume") and slept > 20:
                await _fire(s.get("resumeMode"), "resume (slept %ds)" % int(slept))
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
                        await _fire(s.get(on_true) if cur else s.get(on_false),
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


async def _fan_watch():
    # Enforce the fan curve / manual RPM. SteamOS's jupiter-fan-control rewrites
    # fan1_target on its own poll and may restart on resume, so re-apply on a
    # short cadence; fan_apply only stops the daemon when it's actually running.
    # Module-level (NOT a Plugin method) — Decky's class wrapping breaks self.*.
    owned = False
    tick = 0
    while True:
        try:
            cfg = docky.load_config()
            mode = cfg["settings"].get("fanMode", "auto")
            if mode in ("manual", "curve"):
                # Stop the stock daemon on entry, then re-check only every ~10s
                # (catches it restarting after resume) instead of probing every
                # 2s tick — most ticks just rewrite the target.
                ensure = (not owned) or (tick % 5 == 0)
                await asyncio.to_thread(docky.fan_apply, cfg, ensure)
                owned = True
            elif owned:
                # Just left manual/curve — give the fan back to SteamOS once.
                await asyncio.to_thread(docky.fan_release)
                owned = False
        except asyncio.CancelledError:
            # On unload, hand the fan back so we never leave it stuck (e.g. after
            # an uninstall). Best-effort and synchronous — the loop is ending.
            if owned:
                try:
                    docky.fan_release()
                except Exception:  # noqa: BLE001
                    pass
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("fan watch error")
        tick += 1
        await asyncio.sleep(2)


async def _tdp_watch():
    # Re-apply the configured TDP cap while enforcement is enabled, so Steam's own
    # TDP slider can't override it. No-op when tdpEnforce is off. Module-level —
    # Decky's class wrapping breaks self.method().
    while True:
        try:
            cfg = docky.load_config()
            if cfg["settings"].get("tdpEnforce"):
                await asyncio.to_thread(docky.tdp_apply, cfg)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("tdp watch error")
        await asyncio.sleep(4)


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

    # First guarantee Moonlight discovery works: SteamOS keeps avahi in
    # resolve-only mode and re-disables publishing on updates, which silently
    # breaks host discovery and the <host>.local fallback. Do this BEFORE
    # starting Sunshine so it registers _nvstream cleanly. Runs even when
    # autostart is off, so avahi is ready for a later manual start.
    try:
        res = await asyncio.to_thread(docky.ensure_mdns)
        if res.get("changed") or not res.get("ok"):
            (decky.logger.info if res.get("ok") else decky.logger.warning)(
                "%s", res.get("message"))
    except Exception:  # noqa: BLE001
        decky.logger.exception("ensure mDNS failed")

    try:
        attempted, ok, msg = await asyncio.to_thread(docky.autostart_sunshine)
        if attempted:
            (decky.logger.info if ok else decky.logger.warning)(
                "autostart Sunshine: %s", msg)
    except Exception:  # noqa: BLE001
        decky.logger.exception("autostart Sunshine failed")

    # Verify Sunshine actually became discoverable. ensure_mdns() above ran
    # BEFORE Sunshine existed, so this is the first point we can confirm the end
    # state: at boot Sunshine can register _nvstream into an avahi that isn't up
    # yet (a ~1s race) and stay invisible with no error. If so, re-register.
    try:
        res = await asyncio.to_thread(docky.ensure_discoverable)
        if res.get("healed") or not res.get("ok"):
            (decky.logger.info if res.get("ok") else decky.logger.warning)(
                "discovery heal: %s", res.get("message"))
    except Exception:  # noqa: BLE001
        decky.logger.exception("ensure discoverable failed")


async def _startup_composition():
    # Re-apply the saved force-composition AND force-HDR preferences on load
    # (boot): both gamescope atoms are runtime-only and reset every reboot.
    # Module-level — Decky's class wrapping breaks self.method().
    try:
        await asyncio.to_thread(docky.apply_persisted_composition)
    except Exception:  # noqa: BLE001
        decky.logger.exception("startup composition failed")
    try:
        await asyncio.to_thread(docky.apply_persisted_hdr)
    except Exception:  # noqa: BLE001
        decky.logger.exception("startup HDR failed")


async def _sunshine_watch():
    # Keep an integrated, Docky-owned Sunshine alive: relaunch it if it crashes
    # (e.g. the known session::video segfault). Honors an explicit Stop (docky
    # tracks user intent) and backs off after failures so a Sunshine that dies
    # on startup can't spin. Module-level — Decky's class wrapping breaks self.*.
    fails = 0
    while True:
        await asyncio.sleep(6)
        try:
            if not await asyncio.to_thread(docky.sunshine_should_autorestart):
                fails = 0
                continue
            ok, msg = await asyncio.to_thread(docky.sunshine_autorestart)
            if ok:
                decky.logger.warning("Sunshine watchdog: relaunched (%s)", msg)
            else:
                fails += 1
                decky.logger.warning("Sunshine watchdog: relaunch failed (%s)", msg)
            # Pace relaunch attempts; widen the gap after repeated failures.
            await asyncio.sleep(min(120, 10 + 15 * fails))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("Sunshine watchdog error")
            await asyncio.sleep(10)


async def _mdns_watch():
    # Keep Sunshine discoverable for the whole session, not just at boot.
    # Sunshine registers its _nvstream mDNS record once, at startup; anything
    # that restarts avahi afterwards (a SteamOS update re-disabling publishing,
    # a DHCP/network change) silently drops the record and Moonlight shows "host
    # offline" while Sunshine is otherwise fine. Re-register when that happens —
    # never mid-stream (ensure_discoverable guards on is_streaming). Backs off
    # after a heal or persistent failure so it can't thrash. Module-level —
    # Decky's class wrapping breaks self.*.
    misses = 0
    while True:
        await asyncio.sleep(20)
        try:
            res = await asyncio.to_thread(docky.ensure_discoverable)
            if res.get("healed"):
                decky.logger.warning(
                    "mDNS watchdog: re-registered Sunshine (%s)", res.get("message"))
                misses = 0
                await asyncio.sleep(30)  # let the new record settle
            elif not res.get("ok"):
                misses += 1
                decky.logger.warning("mDNS watchdog: %s", res.get("message"))
                await asyncio.sleep(min(120, 20 * misses))
            else:
                misses = 0
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("mDNS watchdog error")
            await asyncio.sleep(30)


async def _gpu_coexist_watch():
    # Keep Sunshine and the KDE Desktop from fighting over the GPU. Sunshine's KMS
    # capture holds /dev/dri/card0, which blocks KWin from taking DRM master when you
    # switch to Desktop Mode — the desktop then bounces back to Game Mode. Poll fast
    # (2s) so we release the GPU the instant a Plasma session starts launching (before
    # KWin grabs it) and bring Sunshine back in Game Mode, so Moonlight and Desktop
    # RDP both just work. Module-level — Decky's class wrapping breaks self.*.
    while True:
        await asyncio.sleep(2)
        try:
            msg = await asyncio.to_thread(docky.sunshine_coexist_tick)
            if msg:
                decky.logger.info("Sunshine/GPU coexistence: %s", msg)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("GPU coexistence watch error")
            await asyncio.sleep(5)


class Plugin:
    _watch_task = None
    _autostart_task = None
    _startup_task = None
    _fan_task = None
    _tdp_task = None
    _composition_task = None
    _sunshine_watch_task = None
    _mdns_task = None
    _gpu_task = None

    # ---- frontend-callable ----

    async def get_state(self):
        try:
            # get_state probes hardware/flatpak; keep it off the event loop.
            return await asyncio.to_thread(docky.get_state)
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
            # Resets Sunshine's login + restarts it + hits its HTTPS API — all
            # blocking; keep it off the event loop.
            res = await asyncio.to_thread(docky.set_sunshine_login, username, password)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_sunshine_login failed")
            return {"ok": False, "message": str(e)}

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

    async def set_force_composition(self, enabled):
        try:
            res = await asyncio.to_thread(docky.set_force_composition, enabled)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_force_composition failed")
            return {"ok": False, "message": str(e)}

    async def set_force_hdr(self, enabled):
        try:
            res = await asyncio.to_thread(docky.set_force_hdr, enabled)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_force_hdr failed")
            return {"ok": False, "message": str(e)}

    async def set_sunshine_watchdog(self, enabled):
        try:
            res = await asyncio.to_thread(docky.set_sunshine_watchdog, enabled)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_sunshine_watchdog failed")
            return {"ok": False, "message": str(e)}

    # Pairing/client calls hit Sunshine's HTTPS API; keep them off the event loop.
    async def sunshine_pair(self, pin, name):
        try:
            return await asyncio.to_thread(docky.sunshine_pair, pin, name)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_pair failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_clients(self):
        try:
            return await asyncio.to_thread(docky.sunshine_clients)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_clients failed")
            return {"ok": False, "clients": [], "message": str(e)}

    async def sunshine_unpair(self, uuid):
        try:
            return await asyncio.to_thread(docky.sunshine_unpair, uuid)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_unpair failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_unpair_all(self):
        try:
            return await asyncio.to_thread(docky.sunshine_unpair_all)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_unpair_all failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_set_client_enabled(self, uuid, enabled):
        try:
            return await asyncio.to_thread(docky.sunshine_set_client_enabled, uuid, enabled)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_set_client_enabled failed")
            return {"ok": False, "message": str(e)}

    async def set_fan_mode(self, mode, rpm=None):
        try:
            res = await asyncio.to_thread(docky.set_fan_mode, mode, rpm)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_fan_mode failed")
            return {"ok": False, "message": str(e)}

    async def apply_fan_profile(self, profile_id):
        try:
            res = await asyncio.to_thread(docky.apply_fan_profile, profile_id)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("apply_fan_profile failed")
            return {"ok": False, "message": str(e)}

    async def set_tdp_watts(self, watts):
        try:
            res = await asyncio.to_thread(docky.set_tdp_watts, watts)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_tdp_watts failed")
            return {"ok": False, "message": str(e)}

    async def apply_tdp_profile(self, profile_id):
        try:
            res = await asyncio.to_thread(docky.apply_tdp_profile, profile_id)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("apply_tdp_profile failed")
            return {"ok": False, "message": str(e)}

    async def set_tdp_enforce(self, on):
        try:
            res = await asyncio.to_thread(docky.set_tdp_enforce, on)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_tdp_enforce failed")
            return {"ok": False, "message": str(e)}

    async def release_control(self):
        try:
            res = await asyncio.to_thread(docky.release_control)
            res["state"] = docky.get_state()
            return res
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("release_control failed")
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
        self._fan_task = asyncio.create_task(_fan_watch())
        self._tdp_task = asyncio.create_task(_tdp_watch())
        self._composition_task = asyncio.create_task(_startup_composition())
        self._sunshine_watch_task = asyncio.create_task(_sunshine_watch())
        self._mdns_task = asyncio.create_task(_mdns_watch())
        self._gpu_task = asyncio.create_task(_gpu_coexist_watch())
        decky.logger.info("Docky loaded; config=%s", docky.CONFIG_PATH)

    async def _unload(self):
        for task in (self._watch_task, self._autostart_task, self._startup_task,
                     self._fan_task, self._tdp_task, self._composition_task,
                     self._sunshine_watch_task, self._mdns_task, self._gpu_task):
            if task:
                task.cancel()
        decky.logger.info("Docky unloaded")

    async def _uninstall(self):
        pass
