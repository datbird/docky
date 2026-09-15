# Design notes & accepted trade-offs

Deliberate decisions and known limitations — *this is how it is, why, and why
it isn't done another way*. If you're about to "fix" something here, read the
rationale first. For user-facing problems and fixes, see
[Troubleshooting](troubleshooting.md); for contributor how-to, see
[Development](development.md).

## Platform & compatibility

### Requires Decky Loader 3.2.5+ (3.2.6 recommended)
The June 2026 Steam client moved the UI to React 19 and changed how plugin error
boundaries render. Decky Loader ≤ 3.2.4 mis-renders **every** plugin's panel on
that build (React minified error #130, "Something went wrong while displaying
this content") — it is not specific to Docky and a one-line stub panel reproduces
it. **Why not work around it in Docky:** it's a Decky-level rendering change; the
fix belongs in Decky and shipped in 3.2.5/3.2.6 ("fixes for june 2026 beta
errorboundary"). Update Decky.

### Legacy decky-frontend-lib API (`api_version` absent)
The frontend uses DFL's legacy `callPluginMethod` and the runtime-provided
globals (`DFL`, `SP_REACT`). **Why not `api_version ≥ 1` / `@decky/api`:** that's a
full frontend migration for no user-facing gain today; the legacy path works on
current Steam. `api_version` must stay **absent** — Decky blocks legacy calls at
`api_version > 0`.

### Custom `Stepper` instead of DFL `SliderField`
The runtime `DFL` global Decky injects does **not** expose `SliderField` (even
though the npm types do); rendering it crashes the panel with React #130. Docky
uses a `−`/`+` stepper built only from components the runtime guarantees
(`DialogButton`/`Field`/`Focusable`) — which is also friendlier with a gamepad.
**Why not bundle `SliderField`:** it resolves Steam's slider through a webpack
lookup that isn't reliably reachable from a bundled copy.

### Buttons behind the on-screen keyboard fire on `pointerdown`, not `click`
While Steam's virtual keyboard is open, a press on a button underneath it
delivers `pointerdown` **to the button** but the following `click` is retargeted
to the element below — so React's `onClick` never runs. The press is a complete
no-op: no request, no message, no log line. Recorded on-device via CDP:

```
pointerdown -> BUTTON "Pair"   click -> DIV      (swallowed)
pointerdown -> BUTTON "Pair"   click -> BUTTON   (works)
```

This is **not** "press twice" — while the keyboard stays up *every* click is
swallowed, so a keyboard-driven form is unusable until the keyboard is dismissed.
`PairModal` therefore binds `onPointerDown` **as well as** `onClick`, behind a
500 ms timestamp guard (`activate()`) that collapses the two events of one normal
press into a single activation. **Why the guard:** with the keyboard closed both
events reach the button ~160 ms apart, and a doubled submit would fire two
Sunshine API calls. Any future modal with a text field above a submit button
needs the same treatment.

### DFL's `TextFieldProps` advertises `onKeyDown`; Steam's component drops it
`TextFieldProps extends HTMLAttributes<HTMLInputElement>`, so passing `onKeyDown`
type-checks — but that interface is DFL's hand-written description of a component
it locates by sniffing a Steam module at runtime, and the real component doesn't
forward the prop. Verified on-device: the virtual keyboard delivers a genuine
`keydown["Enter"]` to the input element while a `TextField`-level `onKeyDown`
never ran. `TextRow`'s `onEnter` therefore listens on a **wrapper element in the
capture phase**, which sees the event on its way down regardless of what the
component forwards — and can't be hidden by an inner `stopPropagation`. Same
lesson as `bIsPassword` and `SliderField`: **the npm types describe the intended
shape, not what the injected runtime actually honours.** Verify props on-device.

### Modal results go to an OK dialog, not inline text
`PairModal` reports terminal pair/login results through `ConfirmModal`
(`bAlertDialog`). Inline text failed these flows twice over: the on-screen
keyboard covers the bottom of the screen where the status used to render, and
text that appears and disappears reflows the modal, which reads as the page
twitching rather than as an answer. Both produced the same user-visible symptom —
a completed action that looked like nothing happened. The remaining inline status
row is transient progress only and holds its height unconditionally so it can't
reflow. Client-list mutations (unpair/enable/disable) stay inline on purpose: the
row visibly changing is already unambiguous feedback.

### HEVC is exposed as a switch, defaults off, and lives only in Sunshine's config
`hevc_mode` is the only route to HDR (H.264 is 8-bit; Van Gogh has no AV1 encode
block), but HEVC on the Deck is slower than H.264 and its vaapi encoder can emit
an IDR the client can't decode — a connected session with sound, input, and a
black picture. So it's a switch the user opts into, not a default: **on = 3**
(Main + Main10, explicit about HDR rather than leaving it to capability
detection), **off = 1** (a hard "don't offer it", because a client on *Automatic*
takes HEVC whenever the host advertises it).

**Why off is `1` and not simply unset:** Sunshine's default is `0`, which
advertises HEVC whenever the encoder opens — and opening proves nothing about
whether the bitstream decodes. Unset would silently re-enable the broken path.
`get_hevc()` therefore reads an absent key as **on**, so the panel can't show a
switch that disagrees with what clients are offered.

**Why the state isn't mirrored into Docky's settings:** Sunshine's config is the
single source of truth, as it already is for `encoder`. A mirror can drift — the
file gets hand-edited or restored from a backup — and then the panel reports a
setting that isn't in force.

**Why it restarts Sunshine:** the config is read at launch, so writing alone
leaves the switch lying until something else restarts it. The restart is skipped
while `is_streaming()`, the same guard the mDNS re-register and capture-rebuild
paths use; the value is saved and applies when that session ends.

## Performance & hardware

### "Hand control back to SteamOS" lifts the TDP cap to the hardware max, not 15 W
"Default" here means *uncapped* — hand the budget back to SteamOS/Steam so its own
(per-game) TDP can manage it. **Why not 15 W:** 15 W is the stock cap, not
necessarily what Steam or the user wants; forcing it would override Steam's own
choice. The button is labelled "lifted," not "set to 15 W."

### The TDP profile editor goes to 30 W; the hardware clamps
`set_tdp` clamps any value to the device's `power1_cap_max` — 15 W on a stock
Deck, higher on an **unlocked BIOS** (the ceiling varies per unit). **Why allow
30:** so unlocked-BIOS users can reach their raised ceiling; locked Decks simply
clamp. (The panel's *manual* slider, by contrast, is bounded by the live max.)

### TDP enforcement is opt-in (off by default)
With "Keep enforced" on, a loop re-applies the cap every ~4 s so Steam's slider
can't override it — which also means it overrides Steam's **per-game** TDP.
**Why opt-in:** most users want Steam's per-game profiles; a hard global cap is
for the minority who explicitly want one.

### Manual/curve fan control stops `jupiter-fan-control`
SteamOS's fan daemon rewrites `fan1_target` on its own poll, so the two cannot
coexist. Docky stops it while it owns the fan and restarts it on **Auto** and on
plugin unload (so the fan is never left stuck). **Why not coexist:** they would
fight over the same sysfs node.

### The fan loop re-probes the daemon only on entry / every ~10 s
While a curve/manual speed is active, Docky rewrites `fan1_target` every 2 s but
only checks/stops `jupiter-fan-control` via `systemctl` on entry and roughly every
10 s. **Trade-off:** for up to ~10 s after a resume-from-sleep (where the daemon
can restart) the fan may briefly follow SteamOS before Docky re-asserts the curve.
**Why:** avoids spawning a `systemctl` subprocess every 2 s for what can be hours
of continuous fan control.

### Live data is polled, not pushed
The panel polls `get_state` (~4 s; the fan editor ~1.5 s). The legacy Decky API is
request/response — there is no server-push channel. The cost is kept low by
memoizing resolved hwmon paths and using `pgrep` for process checks so each poll
is cheap. **Why not push:** not available in this API.

### Stepped fan curves hold the *lower* point at an exact boundary
In stepped mode (Smooth off), a temperature exactly equal to a point's
temperature holds that point's lower RPM — "hold this speed until the next
threshold is exceeded." Enable **Smooth** for a continuous interpolated ramp.

### PCSX2 detection is cached ~2 s
`pcsx2_running()` is on the poll path and also gates the dock-time
profile-clobber guard; 2 s of staleness is harmless for both, and it's a `pgrep`
rather than a full `/proc` walk. **Why:** it would otherwise run on every rapid
poll.

### PCSX2 pad-profile backups are pruned to the latest 5
A backup of `PCSX2.ini` is written on every profile apply (i.e. every
dock/undock). Unbounded, they would litter the config dir. Five is enough to
recover a recent mistake without accumulating forever.

## Backend

### The backend runs as root
Most of what Docky does needs it: system services, protected sysfs (fan/TDP),
managing other processes, and the Sunshine capture helper. Mitigations: files
created by file-op tasks are chowned back to their parent's owner; subprocesses
run with a sanitized environment; script tasks are opt-in. **Treat your config
like a root cron.** See [Configuration → Security](configuration.md#security).

### The config is root-owned, outside the user's home (1.4.9)
A task can run an arbitrary command as root, so a config the `deck` user can
write is a direct path from `deck` to root on the next trigger. `/var/lib/docky`
is root-owned end to end, the same guarantee the setuid `bwrap` copy already
relied on. **Root-owning the file under `~/.config` would not have worked:**
`~/.config` belongs to `deck`, and rename(2) needs write permission on the parent
only, so the user could swap the whole directory. The cost is that hand-editing
now needs `sudo`; the panel is unaffected. `migrate_legacy_config()` imports the
old file once and renames it `.migrated`.

### `is_running()` (Sunshine) is intentionally **not** cached
It's polled every 0.25 s inside the Sunshine start/stop wait loops; a TTL cache
would return stale values and break those loops. A single `pgrep` per state-poll
is cheap enough to leave uncached. **Why not cache-with-invalidation:** added
complexity and footguns for negligible gain.

### Config/state writes are JSON, locked, with hardware ops outside the lock
`config.json`/`state.json` are read-modify-written under a re-entrant lock so the
panel and the editor can't clobber each other; the slow `systemctl`/sysfs work is
done *outside* the lock so a multi-second daemon restart can't stall other writes.
**Why JSON, not a DB:** it's a few KB of human-editable settings — JSON is the
right tool and keeps the config hand-editable.

### Background coroutines are module-level functions, not `Plugin` methods
Decky's class wrapping breaks `self.method()` calls from inside the backend, so
the watchers (`_trigger_watch`, `_resume_signal_watch`, `_fan_watch`,
`_tdp_watch`, `_sunshine_watch`, `_mdns_watch`, `_gpu_release_watch`,
`_gpu_coexist_watch`, `_atoms_watch`, autostart) are module-level.

### Sunshine discovery is healed by re-registering, never mid-stream
Moonlight discovery needs Sunshine's `_nvstream` mDNS record on the wire, but
Sunshine registers it **only once, at startup** — so a boot race (Sunshine up
before avahi) or a later avahi restart (system update, DHCP change) drops it with
no error. Docky checks the observable end state (is the record actually
advertised?) and, if not, **re-registers by restarting Sunshine** — the only way
to make Sunshine re-emit the record. **Why restart rather than poke avahi:** the
record is Sunshine's to own; there's no API to ask a running Sunshine to
re-advertise. The heal is guarded on `is_streaming()` so it never drops a live
session, uses a short grace window so a just-started Sunshine that's about to
publish isn't bounced needlessly, and the periodic watchdog backs off after a heal
so it can't thrash.

### Capture health is judged from Sunshine's log, and healed by restart
Sunshine builds its KMS capture + encoder pipeline **once, at startup** (and only
re-tests it when a client connects), and never rebuilds it in-process. So if the
display wasn't ready at that instant — a docked boot where the external panel
hadn't trained yet, a resume-from-sleep, a dock/undock that swapped the active
connector — capture stays dead and every stream returns *"Error 503: Failed to
initialize video capture/encoding"* indefinitely. The crash watchdog can't see
this: the process is alive, `is_running()` and even `is_responsive()` (serverinfo
answers) stay true. **The only honest signal is Sunshine's own log** — each probe
ends in a decisive `Found H.264/HEVC encoder` (healthy) or `Unable to find display
or encoder` (the 503). `capture_healthy()` returns the most recent verdict (or
`None` when unknown), keying strictly off those lines and **not** the benign
`Encoder [x] failed` auto-detect noise Sunshine itself says to ignore. The heal is
a restart — the same "only Sunshine can rebuild its own state" logic as the
discovery heal — triggered reactively (a definitive failing verdict) or
proactively: either the active display topology changed (fingerprinted on
connected+enabled connectors, **not** dpms, so a dock/undock triggers it but a
screen merely sleeping does not), or a resume-from-sleep reinitialized the display
without necessarily changing the connector set (rebuilt once the panel is back up).
It's guarded like the others — Game Mode only,
never mid-stream (`is_streaming()`), debounced over consecutive reads, rate-limited
by a cooldown, gated on a display actually being lit (`display_active()` — a
restart into a dark panel would just fail again), and **capped** so a genuinely
unfixable failure (no encoder at all) can't restart-loop. It shares one watchdog
(`_sunshine_watch`) with crash-relaunch, so the two failure modes have a single
owner and can't race to restart.

### The composition gamescope atom is runtime-only, so the preference is persisted
`GAMESCOPE_COMPOSITE_FORCE` is runtime state that resets every reboot (and on
resume-from-sleep). Docky persists the *preference* (`forceComposition`) and
self-heals the atom to match. Setting it needs gamescope's XWayland `:0`, which
isn't always up when the plugin loads — a one-shot boot apply could lose that
race and silently leave a docked image stretched — so the boot apply *retries*
until the atom takes, and a 15 s watchdog (`_atoms_watch` →
`ensure_gamescope_atoms`) reasserts it for the whole session. That
read-before-write watchdog also covers resume and display changes; it no-ops
outside Game Mode (Desktop has no gamescope `:0`).

### HDR is per-stream, so it is deliberately *not* persisted
`GAMESCOPE_DISPLAY_HDR_ENABLED` was once persisted the same way, via a
`forceHdr` setting and a panel toggle. That was a design error, on a wrong
premise: enabling the atom is **not** what allows a Moonlight client to request
an HDR stream. HDR is negotiated in the streaming protocol — Sunshine advertises
the capability from the *encoder* (HEVC Main10 / AV1 10-bit), and the client's
own HDR setting decides. The atom only changes what gamescope renders and scans
out. Latching it on therefore did nothing to enable client-requested HDR while
actively breaking every SDR client, which received PQ-encoded frames it treated
as SDR. It also stayed on with nobody streaming.

The setting and its self-heal are gone. The `sunshine_hdr` task remains for
explicit, user-driven switching (a real HDR TV on a Dock trigger, say), where the
user is choosing the output mode deliberately rather than having it latched.
Matching HDR to what a client actually asked for belongs in a Sunshine
`global_prep_cmd` keyed on `${SUNSHINE_CLIENT_HDR}`, which is per-session and
undone when the stream ends.

### Streaming and the desktop can't share the GPU, so Docky hands it off
Sunshine's `capture=kms` and KWin (the KDE desktop compositor) both need
exclusive DRM-master on `/dev/dri/card0`, and only one process can hold it. They
therefore can't run at once — the issue is the **handoff** between Game Mode
(Sunshine) and Desktop Mode (KWin, which is what RDP shows). A fast (0.25 s)
release loop frees the GPU by **SIGKILLing Sunshine the instant gamescope stops
being the compositor** (within ~50 ms — fast because KWin's DRM-master retry
window is only a few seconds), a 2 s coexistence loop keeps Sunshine off while a
Plasma session exists (the Desktop *latch*) and restarts Sunshine only once
gamescope is **stably** back (a *debounce*, so a flickering/bouncing transition
can't restart it mid-handoff). **Why key off
gamescope-gone rather than detecting Plasma:** it makes "stop Sunshine" impossible
while Game Mode is up, so a missed detection leaves Moonlight working instead of
killing a stream — the safe failure direction. **Why not share the GPU:** DRM
master is exclusive; there is no share option. The related **Steam autostart
wrapper** (a `~/.config/autostart/steam.desktop` override → `steam-wait-x.sh`)
solves a *different* race in the same Desktop-over-RDP flow — Steam autostarting
before Xwayland is ready — and is deployed by `install.sh` rather than baked into
the plugin runtime because it's a desktop-session concern, not Game-Mode logic.
The desktop's own side (krdpserver listening on 3389, the KRDP watchdog) is
deliberately **outside** Docky. Full narrative:
[Streaming ⇄ Desktop](gpu-coexistence.md).

## Frontend

### The editor deep-clones the whole config on each edit
`mutate` does a JSON round-trip for immutable updates. At realistic config sizes
(a few KB) the cost is negligible and the simplicity is worth it. **Why not
fine-grained immutable updates:** more code and bug surface for no measurable
gain.

### Curve-point lists use array indices as React keys
Curve points have no stable id and the list is fully controlled — it re-renders
from the new array on every change, so index keys self-correct. (Tasks, which are
reordered/removed independently, carry a client-only `__key` instead.)

### The panel keeps polling while a modal is open
`showModal` doesn't unmount the panel, so the panel's poll and a modal's own poll
can briefly overlap. After the hot-path optimizations each `get_state` is cheap,
so suppressing the duplicate isn't worth the cross-component coordination.

## Packaging

### `dist/index.js` is a gitignored build artifact
It is **not** committed — the Decky store rebuilds the frontend from source
(matching the official plugin template), so a committed bundle is redundant.
`install.sh` refuses to run if it's missing; run `pnpm run build` after any
`src/` change. **Why not commit it for Node-less installs:** ship it in Release
zips instead, so the source tree stays free of a generated artifact.

### Asset `publicPath` uses the plugin name (`Docky`), not the install folder
Decky serves plugin files by the **registered plugin name** (`/plugins/Docky/…`),
not the lowercase install folder. There are currently no bundled asset imports, so
this path is unused today, but it is already correct for when one is added.
