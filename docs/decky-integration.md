# Decky integration & the webpack boundary

How a Decky plugin plugs into Steam, what **"patches"** and **"webpack"** mean in
this world, and the deliberate line Docky draws between itself and Valve's UI.
Read this for the *mental model*; for the concrete trade-offs it produces see
[Design notes](design-notes.md), and for build/deploy see
[Development](development.md).

## Two ways a Decky plugin can integrate

A Decky plugin can reach Steam in one of two fundamentally different ways:

1. **Deep integration** — reach *into* Steam's own running UI: add a button to a
   game's library page, inject a badge into the store, restyle the whole
   interface, read Valve's internal state stores. This is done with **patches**
   over modules found in Steam's **webpack** bundle (below). Examples: CSS
   Loader (reskins everything), SteamGridDB (rewrites artwork), ProtonDB /
   HowLongToBeat (inject info into the game page).

2. **Self-contained panel** — render only inside the Quick Access panel Decky
   hands the plugin, and push the real work to a backend. The plugin never
   modifies Valve's screens or reads Valve's private runtime state. **This is
   Docky's model.**

Neither is "better" — they're a **capability trade-off**. Deep integration is the
only way to change what Steam's own UI looks like or to read state Valve doesn't
expose; the price is that it's fragile across SteamOS updates. A self-contained
panel can't touch Valve's screens at all, but in exchange it barely notices most
Steam updates.

## What "webpack" actually means here

It is **not** the build tool that bundles *your* plugin (Docky builds with
rollup; see [Development](development.md)). It refers to **Steam's own frontend
bundle**.

- Steam's UI (GamepadUI / SteamUI) is a **Chromium/CEF web app** — React running
  in an embedded browser. Valve compiles all of it with **webpack** into a
  handful of minified JS **chunks**.
- What exists at runtime is that bundle's **module registry**: an in-memory map
  of `moduleID → compiled module`, loaded when the UI boots. Decky and
  `decky-frontend-lib` (DFL) reach into that live cache to grab Valve's
  components, classes, and stores.
- **There are no source folders or paths at runtime.** Webpack erases the file
  structure — a module isn't `components/GameCard.tsx`, it's module `#48213`
  with minified exports (`a`, `bZ`, `_r`). You locate one by a **fingerprint**: a
  unique export name, a magic string, a distinctive prop.

**Why SteamOS updates hurt:** every update ships a freshly compiled bundle.
Module **IDs** renumber, minified **export names** churn (`bZ` → `k9`), and
module **shapes** shift (a prop renames, a signature gains an argument). Any
plugin that grabbed a module by fingerprint now matches nothing and silently
breaks. "Digging through the webpack" is the recurring fix: open CEF devtools,
inspect the module cache, find the module's new fingerprint, and rewrite the
lookup. This is the single biggest ongoing maintenance tax on deep-integration
plugins.

## What "patches" means

Not git patches or diffs — **runtime monkey-patching of Steam's own React code.**
DFL ships the helpers: `afterPatch`, `beforePatch`, `replacePatch`,
`wrapReactType`, `wrapReactClass`. You intercept a *Valve* function's return
value and splice your own elements into Steam's native React tree — that's how a
plugin adds a control to the Quick Access header, injects into a game page, or
registers a whole new route (`serverAPI.routerHook.addRoute` / `addPatch`).

Patches and webpack are **two halves of one workflow**: use a webpack lookup to
get a reference to Valve's internal function/component, then patch it to inject
your behaviour. Both break when Valve reshuffles the bundle.

## Where Docky sits — and why

Docky is entirely **self-contained panel + Python backend**:

- The frontend renders only into Decky's panel and its own `ModalRoot` modals.
- Everything real happens in the **root Python backend** over `call()` — writing
  sysfs for fan/TDP, running Sunshine, swapping modes, dock fixes.
- It **never** patches Valve's UI and **never** does a `findModule` lookup of its
  own.

Because Docky's features are "control the OS," not "change Steam's screens," the
self-contained shape is the *natural correct* architecture — and it means Docky
sails through most SteamOS updates that would send a deep-integration plugin back
into devtools.

**Why don't all plugins do this?** Because for many the feature *is* modifying
Steam's UI or reading Valve's internal stores — CSS themers, artwork managers,
game-page overlays. There's no self-contained version of "reskin the library."
They pay the webpack tax because the thing they exist to do only lives inside the
bundle. Docky simply has a problem that doesn't require crossing that line.

## Docky's residual exposure (it isn't zero)

Docky doesn't escape webpack **entirely** — it just owns **no custom** webpack or
patch code. The DFL widgets it imports (`Field`, `Focusable`, `TextField`,
`ModalRoot`, …) are themselves found via `findModule` **inside DFL**. DFL absorbs
the drift on Docky's behalf, so the exposure shows up as *"which DFL widgets and
props exist in this build,"* not as raw module hunting:

- **`SliderField` isn't in the injected `DFL` global** — rendering it crashes the
  panel with React #130, so Docky hand-rolls a `Stepper` from guaranteed
  primitives. (See [Design notes](design-notes.md).)
- **`bIsPassword`** masking on `TextField` is cast through `any`; a renamed prop
  fails silently to plaintext (`src/components/inputs.tsx`).
- **`<Focusable flow-children="horizontal">`** relies on that prop name surviving
  in the runtime library.

**Mitigation:** when SteamOS moves things, the fix is usually to bump the DFL
version rather than to re-find modules by hand. The fragility is real but
**DFL-version-shaped**, not custom-lookup-shaped — a much cheaper category of
maintenance.

## Marketplace precedent

None of this is just theory — every technique Docky uses has an equivalent in an
*approved* Decky-store plugin (verified against the `decky-plugin-database`
submodule manifest, the source of truth for what the built-in store lists):

| Docky technique | Approved-store precedent |
|---|---|
| Self-contained QAM panel, no Steam-UI patching | The baseline plugin shape — official `decky-plugin-template`; **vibrantDeck** and **SimpleDeckyTDP** are panel-only |
| Root Python backend over the `call` bridge | The canonical Decky architecture — template + **PowerTools**, **Decky-Undervolt** |
| TDP via sysfs `power1_cap` / ryzenadj | **PowerTools** (writes `power1_cap`), **Decky-Undervolt** (ryzenadj from Python) |
| Fan curve that stops `jupiter-fan-control` | **Fantastic** (NGnius) — disables the SteamOS fan daemon while it owns the fan |
| Sunshine / Moonlight from the plugin | **MoonDeck** (session automation), **decky-sunshine** (manages the Sunshine host) |
| `setsid`-detached Sunshine surviving a loader restart | **decky-sunshine** launches Sunshine with `start_new_session=True` — the same detach |
| Legacy `decky-frontend-lib`, `api_version` absent | **vibrantDeck** is live on the store with no `api_version` |
| Persistent backend event watchers (asyncio) | **MoonDeck** runs a long-lived backend loop and reacts to suspend/resume via OS signals |

Two places Docky is deliberately in the minority:

- **Backend trigger engine.** Watching dock / AC / controller in the Python
  backend — rather than the frontend via SteamClient events — is the less common
  choice; most plugins do UI-facing reactions frontend-side. But Docky's
  automation must fire *when the panel is closed*, which a self-contained panel
  can't do from the frontend without the global patching it avoids. **MoonDeck**
  validates the backend-automation approach: it reacts to suspend/resume via
  `SIGUSR1`/`SIGUSR2`, and Docky similarly catches resume from logind's
  `PrepareForSleep` signal (with a boottime-delta poll as backstop — see
  [Triggers](triggers.md)).
- **Custom `Stepper`.** Building a control by hand because a DFL component isn't
  in the injected runtime is defensible given DFL's fragility (above), but no
  store plugin was found documenting that exact reason — so it rests on the
  general robustness argument, not a named precedent.

(Note: **SimpleDeckyTDP** is a corroborating implementation but is
*self-distributed*, not in the store database; PowerTools, Decky-Undervolt,
Fantastic, MoonDeck, and decky-sunshine are the properly store-listed citations.)

## Rule of thumb

If a proposed feature needs to **change what a Valve screen looks like** or
**read state Valve doesn't expose**, it necessarily crosses into webpack +
patches, with all the update fragility that implies — so prefer to do the work in
the **backend** wherever possible and keep the frontend a self-contained panel.
Reach for patches only when injecting into Valve's own UI is genuinely the
feature.
