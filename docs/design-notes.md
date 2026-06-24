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
the watchers (`_trigger_watch`, `_fan_watch`, `_tdp_watch`, autostart) are
module-level.

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

### `dist/index.js` is committed
So a fresh clone installs with **no Node toolchain**; the store CI rebuilds it.
Rebuild and commit it with any `src/` change.

### Asset `publicPath` uses the plugin name (`Docky`), not the install folder
Decky serves plugin files by the **registered plugin name** (`/plugins/Docky/…`),
not the lowercase install folder. There are currently no bundled asset imports, so
this path is unused today, but it is already correct for when one is added.
