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


# Detached background tasks (e.g. the post-resume capture rebuild) — held in a set
# so they aren't garbage-collected mid-flight, and discarded when they finish.
# _unload() cancels these too; a detached task surviving teardown would keep
# touching Sunshine after the plugin is gone.
_bg_tasks = set()


def _spawn(coro):
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)
    return t


# Starting Sunshine has two callers on two cadences: _gpu_coexist_watch (2s, via
# sunshine_coexist_tick's START branch) and _sunshine_watch (6s, via
# sunshine_autorestart). Both gate on the same "not running + Game Mode stable"
# condition, so without this they can both pass the check and both launch. The
# lock makes check-and-start atomic between them. Held only around the start
# paths — never around the capture heal, which blocks for seconds.
_sunshine_start_lock = asyncio.Lock()


# ---- blocking helpers (run via asyncio.to_thread; never call on the loop) ----

def _poll_snapshot():
    """One thread hop for a whole trigger poll: config, state, and the current
    reading of every ENABLED trigger. The readings are sysfs/proc probes, so
    they belong off the event loop with the two file reads rather than being
    three more hops."""
    cfg = docky.load_config()
    s = cfg["settings"]
    st = docky.load_state()
    readings = {field: read(cfg)
                for flag, field, read, _t, _f, _l in _TRANSITION_TRIGGERS
                if s.get(flag)}
    return cfg, st, readings


def _fan_tick(owned, ensure_now):
    """One thread hop for a fan tick: load config, then apply or release.
    Returns the new `owned`. (load_config() used to run on the event loop while
    only the apply was threaded — backwards; the read is the blocking part.)"""
    cfg = docky.load_config()
    if cfg["settings"].get("fanMode", "auto") in ("manual", "curve"):
        docky.fan_apply(cfg, ensure_now or not owned)
        return True
    if owned:
        # Just left manual/curve — give the fan back to SteamOS once.
        docky.fan_release()
    return False


def _tdp_tick():
    """One thread hop for a TDP tick. No-op when enforcement is off."""
    cfg = docky.load_config()
    if cfg["settings"].get("tdpEnforce"):
        docky.tdp_apply(cfg)


async def _call(fn, *args, with_state=True, **kwargs):
    """Run a blocking docky call off the event loop and, by default, attach a
    fresh get_state() — ALSO off the loop.

    That second hop is the point. Every mutator used to finish with
    `res["state"] = docky.get_state()` inline, which put the single most
    expensive call in the plugin (flatpak probe, a gamescope atom read per
    favorite, sysfs, /proc) directly on the event loop — stalling every watcher,
    including the 0.25s GPU release loop that has ~0.3s to free the card before
    a Desktop switch bounces.

    Raises on failure; callers shape their own error response."""
    res = await asyncio.to_thread(fn, *args, **kwargs)
    if with_state and isinstance(res, dict):
        res["state"] = await asyncio.to_thread(docky.get_state)
    return res


# ---- watchers ----

async def _capture_rebuild_after_resume(slept):
    # After resume-from-sleep the display re-initializes (gamescope atoms reset,
    # the panel re-trains) but usually with the SAME connectors — so neither the
    # reactive capture check nor the topology detector fires, yet Sunshine's
    # once-at-launch capture pipeline can be stale (Error 503 on the first connect).
    # Wait for a display to wake, then proactively rebuild. Detached, bounded
    # (~30s), and cooldown-shared with the watchdog so the two can't double-restart.
    for _ in range(15):  # give the panel up to ~30s to come back
        await asyncio.sleep(2)
        try:
            if await asyncio.to_thread(docky.sunshine_display_lit):
                break
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            break
    try:
        res = await asyncio.to_thread(docky.rebuild_capture_after_resume)
        if res and res.get("healed"):
            decky.logger.warning("Sunshine capture watchdog: %s (resumed, slept %ds)",
                                 res.get("message"), int(slept))
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        decky.logger.exception("resume capture rebuild failed")


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
            cfg, st, readings = await asyncio.to_thread(_poll_snapshot)
            s = cfg["settings"]
            try:
                poll = max(1, min(3600, int(s.get("pollSeconds", 3))))
            except (TypeError, ValueError):
                poll = 3

            # resume detection: boot-time advanced far more than awake time.
            # Skip the first iteration (its delta isn't a real suspend).
            mono1 = time.monotonic()
            boot1 = time.clock_gettime(time.CLOCK_BOOTTIME)
            slept = (boot1 - boot0) - (mono1 - mono0)
            mono0, boot0 = mono1, boot1
            if not first and slept > 20:
                if s.get("autoResume"):
                    await _fire(s.get("resumeMode"), "resume (slept %ds)" % int(slept))
                # Rebuild Sunshine's capture after a real sleep regardless of the
                # resume-Mode trigger — capture health is independent of it.
                _spawn(_capture_rebuild_after_resume(slept))
            first = False

            # Collect only the baseline fields that changed, then merge them
            # atomically — never write back the whole (stale) state object, which
            # would clobber an activeMode a fired trigger just set.
            changes = {}
            for flag, field, _read, on_true, on_false, label in _TRANSITION_TRIGGERS:
                if field not in readings:
                    continue  # trigger disabled; _poll_snapshot skipped it
                cur = readings[field]
                last = st.get(field)
                if cur != last:
                    if last is not None:
                        await _fire(s.get(on_true) if cur else s.get(on_false),
                                    "%s %s" % (label, "on" if cur else "off"))
                    changes[field] = cur
            if changes:
                # update_state fsyncs; that has no business on the event loop.
                await asyncio.to_thread(docky.update_state, **changes)
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
            # Stop the stock daemon on entry, then re-check only every ~10s
            # (catches it restarting after resume) instead of probing every
            # 2s tick — most ticks just rewrite the target.
            owned = await asyncio.to_thread(_fan_tick, owned, tick % 5 == 0)
        except asyncio.CancelledError:
            # On unload, hand the fan back so we never leave it stuck (e.g. after
            # an uninstall). Best-effort and synchronous — the loop is ending, and
            # an await here could be aborted by a second cancel before it lands.
            # This only runs at all because _unload() AWAITS the cancelled tasks;
            # a bare cancel() would let the plugin die with the fan still pinned.
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
            await asyncio.to_thread(_tdp_tick)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("tdp watch error")
        await asyncio.sleep(4)


async def _startup_trigger():
    # Run the startup mode once on load (boot), if enabled. Off the event loop
    # since it may run blocking tasks.
    try:
        cfg = await asyncio.to_thread(docky.load_config)
        s = cfg["settings"]
        if s.get("autoStartup") and s.get("startupMode"):
            decky.logger.info("trigger startup -> mode '%s'", s["startupMode"])
            await asyncio.to_thread(docky.activate_mode, s["startupMode"],
                                    allow_running_emu=False)
    except asyncio.CancelledError:
        raise
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
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        decky.logger.exception("ensure mDNS failed")

    try:
        # Shares the start lock with the watchers: _main launches this task
        # alongside them, so without it the 2s coexist loop could reach a start
        # while this one is still in flight.
        async with _sunshine_start_lock:
            attempted, ok, msg = await asyncio.to_thread(docky.autostart_sunshine)
        if attempted:
            (decky.logger.info if ok else decky.logger.warning)(
                "autostart Sunshine: %s", msg)
    except asyncio.CancelledError:
        raise
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
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        decky.logger.exception("ensure discoverable failed")


async def _atoms_watch():
    # Keep the runtime gamescope atoms (force-composition, force-HDR) matching
    # the saved preferences for the whole session. Both reset every reboot AND on
    # resume-from-sleep, and can be dropped by display/mode changes. Cheap (reads
    # before writing, no-ops outside Game Mode). Module-level — Decky's class
    # wrapping breaks self.*.
    #
    # Boot phase first: setting the atoms needs gamescope's XWayland :0, which
    # may not be up yet when the plugin loads, so a one-shot apply can lose that
    # race and silently leave the docked image stretched. Retry fast (~60s) until
    # the atoms confirm, then settle into the periodic heal.
    #
    # This was two tasks — a 2s _startup_composition and a 15s _atoms_watch —
    # which overlapped from t=15s to t=60s, both driving the same xprop reads and
    # writes against the same atoms. One owner, two phases.
    for _ in range(30):
        try:
            res = await asyncio.to_thread(docky.ensure_gamescope_atoms)
            if res is True:
                break  # everything desired is confirmed applied
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("startup composition/HDR apply failed")
        await asyncio.sleep(2)

    while True:
        await asyncio.sleep(15)
        try:
            res = await asyncio.to_thread(docky.ensure_gamescope_atoms)
            if res is False:
                decky.logger.warning(
                    "atoms watchdog: gamescope :0 not ready / atom didn't take")
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("atoms watchdog error")
            await asyncio.sleep(30)


async def _sunshine_watch():
    # Keep an integrated, Docky-owned Sunshine both ALIVE and ABLE TO CAPTURE.
    # Two failure modes:
    #   • not running — relaunch it (e.g. the known session::video segfault);
    #   • running but capture is dead — the "Error 503: failed to init video
    #     capture" state after a docked boot / resume / dock change, which the
    #     liveness check can't see because the process stays up and responsive.
    # Honors an explicit Stop (docky tracks user intent) and backs off after
    # failures so a Sunshine that dies on startup can't spin. ensure_capture_healthy
    # is itself debounced / cooldown-limited / capped and never acts mid-stream.
    #
    # The relaunch runs under _sunshine_start_lock because it is NOT the only
    # start path — sunshine_coexist_tick's START branch checks the same condition
    # on a 2s cadence. Without the lock both can pass "not running" and both
    # launch. The capture heal stays outside it: it blocks for seconds and only
    # ever acts on an ALREADY-running Sunshine, which no start path will touch.
    # Module-level — Decky's class wrapping breaks self.*.
    fails = 0
    while True:
        await asyncio.sleep(6)
        try:
            started = None
            async with _sunshine_start_lock:
                if await asyncio.to_thread(docky.sunshine_should_autorestart):
                    started = await asyncio.to_thread(docky.sunshine_autorestart)
            if started is not None:
                ok, msg = started
                if ok:
                    fails = 0
                    decky.logger.warning("Sunshine watchdog: relaunched (%s)", msg)
                else:
                    fails += 1
                    decky.logger.warning("Sunshine watchdog: relaunch failed (%s)", msg)
                # Pace relaunch attempts; widen the gap after repeated failures.
                await asyncio.sleep(min(120, 10 + 15 * fails))
                continue
            fails = 0
            # Running: make sure it can actually CAPTURE (Error 503 heal).
            res = await asyncio.to_thread(docky.ensure_capture_healthy)
            if res and (res.get("healed") or not res.get("ok")):
                decky.logger.warning("Sunshine capture watchdog: %s", res.get("message"))
                if res.get("healed"):
                    await asyncio.sleep(30)  # let the fresh capture pipeline settle
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


async def _gpu_release_watch():
    # PRIMARY GPU release: free /dev/dri/card0 the instant Game Mode ends, before the
    # KDE desktop (or a gamescope relaunch) reaches for it. The 2s coexist loop below
    # is too slow — a switch-to-Desktop needs the card within ~0.3-0.5s or it bounces,
    # and while streaming the old guard refused to release at all (proven 2026-07-17:
    # ~25s black-screen deadlock; freeing within ~50ms let the desktop come up clean).
    # Poll fast (0.25s) but stay cheap: sunshine_release_tick() short-circuits on a
    # fresh gamescope check and only touches Sunshine when Game Mode has actually gone.
    # Module-level — Decky's class wrapping breaks self.*.
    #
    # REQUIRES (engine side): sunshine_release_tick() must read gamescope's liveness
    # with max_age=0. docky._running_comms() memoizes for 0.5s, which is longer than
    # this loop's whole period — a cached answer would make the 0.25s cadence
    # meaningless (0.5s stale + 0.25s poll = up to 0.75s to notice, i.e. back to
    # bouncing). It must also not re-scan all of /proc at 4Hz just to answer one
    # question: pin gamescope's pid and read /proc/<pid>/comm, rescanning only when
    # it's gone. (The real answer is os.pidfd_open() + loop.add_reader(), which
    # fires on exit with no polling at all; this cadence is the stopgap.)
    while True:
        await asyncio.sleep(0.25)
        try:
            msg = await asyncio.to_thread(docky.sunshine_release_tick)
            if msg:
                decky.logger.info("Sunshine/GPU coexistence: %s", msg)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            decky.logger.exception("GPU release watch error")
            await asyncio.sleep(5)


async def _gpu_coexist_watch():
    # Slower coexistence loop (2s): brings Sunshine BACK once Game Mode is stably up,
    # and acts as a backstop STOP for cases the fast release loop above doesn't cover
    # (e.g. a desktop session appearing while a gamescope process briefly overlaps).
    # Sunshine's KMS capture holds /dev/dri/card0, which blocks KWin from taking DRM
    # master; the release loop frees it fast, this loop restores Sunshine in Game Mode
    # so Moonlight and Desktop RDP both just work. Module-level — Decky's class
    # wrapping breaks self.*.
    #
    # Under _sunshine_start_lock because the tick's START branch races
    # _sunshine_watch's relaunch: same "not running + Game Mode stable" condition,
    # 2s vs 6s, previously with nothing serializing check-and-start. Taking the
    # lock costs this loop nothing in the common case (uncontended) and never
    # delays the STOP path, which lives in _gpu_release_watch above.
    while True:
        await asyncio.sleep(2)
        try:
            async with _sunshine_start_lock:
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
    _sunshine_watch_task = None
    _mdns_task = None
    _gpu_task = None
    _gpu_release_task = None
    _atoms_task = None

    # ---- frontend-callable ----
    #
    # Every method here is a thin shell over _call(): thread the work, thread the
    # get_state() that gets attached to the response, shape the error. The error
    # shapes genuinely differ per method, which is why they aren't factored out —
    # but nothing below may touch docky.* directly. A synchronous call here stalls
    # the 0.25s GPU release loop, and run_action can legitimately take 60s.

    async def get_state(self):
        try:
            # get_state probes hardware/flatpak; keep it off the event loop.
            return await asyncio.to_thread(docky.get_state)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("get_state failed")
            return {"error": str(e)}

    async def run_action(self, action_id):
        try:
            # Runs arbitrary user tasks (bash/python/run) at up to
            # DEFAULT_TIMEOUT=60s each. Inline, that froze every watcher for the
            # duration — including the GPU release loop that has ~0.3s to act.
            res = await asyncio.to_thread(docky.run_action, action_id,
                                          allow_running_emu=True)
            decky.logger.info("run_action(%s) ok=%s", action_id, res.get("ok"))
            state = await asyncio.to_thread(docky.get_state)
            return {"result": res, "state": state}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("run_action failed")
            return {"result": {"ok": False, "message": str(e)}}

    async def activate_mode(self, mode_id):
        try:
            res = await asyncio.to_thread(docky.activate_mode, mode_id,
                                          allow_running_emu=True)
            decky.logger.info("activate_mode(%s) ok=%s", mode_id, res.get("ok"))
            state = await asyncio.to_thread(docky.get_state)
            return {"result": res, "state": state}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("activate_mode failed")
            return {"result": {"ok": False, "message": str(e)}}

    async def set_trigger(self, key, enabled):
        try:
            settings = await asyncio.to_thread(docky.set_trigger, key, enabled)
            state = await asyncio.to_thread(docky.get_state)
            return {"settings": settings, "state": state}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_trigger failed")
            return {"error": str(e)}

    async def set_sunshine_login(self, username, password):
        try:
            # Resets Sunshine's login + restarts it + hits its HTTPS API — all
            # blocking; keep it off the event loop.
            return await _call(docky.set_sunshine_login, username, password)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_sunshine_login failed")
            return {"ok": False, "message": str(e)}

    # Sunshine install/update/version-check hit flatpak + the network, so run
    # them off the event loop to keep the UI responsive.
    async def sunshine_install(self):
        try:
            return await _call(docky.sunshine_install)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_install failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_update(self):
        try:
            return await _call(docky.sunshine_update)
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
    # off the event loop to keep the UI responsive. They also take the start lock
    # so an explicit user Start can't collide with a watcher's relaunch.
    async def sunshine_start(self):
        try:
            async with _sunshine_start_lock:
                return await _call(docky.sunshine_start)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_start failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_stop(self):
        try:
            return await _call(docky.sunshine_stop)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_stop failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_restart(self):
        try:
            async with _sunshine_start_lock:
                return await _call(docky.sunshine_restart)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_restart failed")
            return {"ok": False, "message": str(e)}

    async def set_force_composition(self, enabled):
        try:
            return await _call(docky.set_force_composition, enabled)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_force_composition failed")
            return {"ok": False, "message": str(e)}

    async def set_force_hdr(self, enabled):
        try:
            return await _call(docky.set_force_hdr, enabled)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_force_hdr failed")
            return {"ok": False, "message": str(e)}

    async def set_sunshine_watchdog(self, enabled):
        try:
            return await _call(docky.set_sunshine_watchdog, enabled)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_sunshine_watchdog failed")
            return {"ok": False, "message": str(e)}

    # Pairing/client calls hit Sunshine's HTTPS API; keep them off the event loop.
    async def sunshine_pair(self, pin, name):
        try:
            return await _call(docky.sunshine_pair, pin, name, with_state=False)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_pair failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_clients(self):
        try:
            return await _call(docky.sunshine_clients, with_state=False)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_clients failed")
            return {"ok": False, "clients": [], "message": str(e)}

    async def sunshine_unpair(self, uuid):
        try:
            return await _call(docky.sunshine_unpair, uuid, with_state=False)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_unpair failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_unpair_all(self):
        try:
            return await _call(docky.sunshine_unpair_all, with_state=False)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_unpair_all failed")
            return {"ok": False, "message": str(e)}

    async def sunshine_set_client_enabled(self, uuid, enabled):
        try:
            return await _call(docky.sunshine_set_client_enabled, uuid, enabled,
                               with_state=False)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("sunshine_set_client_enabled failed")
            return {"ok": False, "message": str(e)}

    async def set_fan_mode(self, mode, rpm=None):
        try:
            return await _call(docky.set_fan_mode, mode, rpm)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_fan_mode failed")
            return {"ok": False, "message": str(e)}

    async def apply_fan_profile(self, profile_id):
        try:
            return await _call(docky.apply_fan_profile, profile_id)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("apply_fan_profile failed")
            return {"ok": False, "message": str(e)}

    async def set_tdp_watts(self, watts):
        try:
            return await _call(docky.set_tdp_watts, watts)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_tdp_watts failed")
            return {"ok": False, "message": str(e)}

    async def apply_tdp_profile(self, profile_id):
        try:
            return await _call(docky.apply_tdp_profile, profile_id)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("apply_tdp_profile failed")
            return {"ok": False, "message": str(e)}

    async def set_tdp_enforce(self, on):
        try:
            return await _call(docky.set_tdp_enforce, on)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("set_tdp_enforce failed")
            return {"ok": False, "message": str(e)}

    async def release_control(self):
        try:
            return await _call(docky.release_control)
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("release_control failed")
            return {"ok": False, "message": str(e)}

    async def get_config(self):
        try:
            cfg = await asyncio.to_thread(docky.load_config)
            return {"config": cfg, "path": docky.CONFIG_PATH}
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}

    async def save_config(self, config):
        try:
            # Writes + fsyncs; not the event loop's job.
            await asyncio.to_thread(docky.save_config, config)
            state = await asyncio.to_thread(docky.get_state)
            return {"ok": True, "state": state}
        except Exception as e:  # noqa: BLE001
            decky.logger.exception("save_config failed")
            return {"ok": False, "error": str(e)}

    # ---- lifecycle + auto-dock watcher ----

    async def _main(self):
        await asyncio.to_thread(docky.load_config)  # ensure default exists
        self._watch_task = asyncio.create_task(_trigger_watch())
        self._autostart_task = asyncio.create_task(_autostart_sunshine())
        self._startup_task = asyncio.create_task(_startup_trigger())
        self._fan_task = asyncio.create_task(_fan_watch())
        self._tdp_task = asyncio.create_task(_tdp_watch())
        self._sunshine_watch_task = asyncio.create_task(_sunshine_watch())
        self._mdns_task = asyncio.create_task(_mdns_watch())
        self._gpu_task = asyncio.create_task(_gpu_coexist_watch())
        self._gpu_release_task = asyncio.create_task(_gpu_release_watch())
        # Boot-phase retry + periodic heal for the gamescope atoms, one task.
        self._atoms_task = asyncio.create_task(_atoms_watch())
        decky.logger.info("Docky loaded; config=%s", docky.CONFIG_PATH)

    async def _unload(self):
        # Build the task list inline, NOT via a self._tasks() helper: Decky wraps
        # the Plugin class, so an internal self.method() call resolves to the
        # UNBOUND method and throws "TypeError: missing 'self'" — which would abort
        # _unload before anything is cancelled, leaking Sunshine/bwrap and skipping
        # the fan hand-back below. Same gotcha that forces the watchers module-level.
        # Include the detached tasks (_capture_rebuild_after_resume) too — one
        # surviving teardown would keep restarting Sunshine after Docky is gone.
        own = (self._watch_task, self._autostart_task, self._startup_task,
               self._fan_task, self._tdp_task, self._sunshine_watch_task,
               self._mdns_task, self._gpu_task, self._gpu_release_task,
               self._atoms_task)
        tasks = [t for t in own if t] + list(_bg_tasks)
        for task in tasks:
            task.cancel()
        # cancel() only REQUESTS cancellation: it schedules CancelledError to be
        # raised at each task's next resumption. Returning here without awaiting
        # meant _fan_watch's handler — the one that hands the fan back to SteamOS
        # so an unload/uninstall doesn't leave it pinned at Docky's last target
        # with jupiter-fan-control stopped — might never run at all. Bounded,
        # because that handler shells to systemctl.
        if tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True), timeout=20)
            except asyncio.TimeoutError:
                decky.logger.warning("Docky: watchers didn't stop within 20s; "
                                     "the fan may still be under Docky's control")
            except Exception:  # noqa: BLE001
                decky.logger.exception("Docky: error awaiting watcher shutdown")
        decky.logger.info("Docky unloaded")

    async def _uninstall(self):
        pass
