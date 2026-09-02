# Proposal: game session triggers

**Status:** proposal. Nothing here is implemented.

Adds two triggers, **Game start** and **Game exit**, so a Mode can run around a
game session. For the existing triggers see [Triggers](../triggers.md); for the
Task/Action/Mode model see [Concepts](../concepts.md).

## The gap

Every trigger Docky has today watches the *device*: dock, AC power, controller,
resume, startup. None of them watch the thing the user actually does, which is
play a game.

That rules out a class of automation Docky is otherwise well shaped for. The
motivating case is **save sync for games Steam Cloud does not cover**. Tools like
Ludusavi can back up and restore those saves, and a file sync tool can move the
backups between machines, but something has to decide *when*. Right now that is
the user, by hand, and a forgotten step means loading a stale save on the other
machine.

The trigger itself is general. Save sync is the first use, not the only one.

## Two mechanisms, and why the difference decides the design

There are two ways to know a game started, and they are not interchangeable.

| | Observer | Wrapper |
|---|---|---|
| How | `SteamClient.GameSessions.RegisterForAppLifetimeNotifications` | a shim in the game's launch options |
| Touches launch options | no | yes |
| Fires on start | alongside launch | **before** the process |
| Fires on exit | yes | yes |
| Can break the game | no | yes, if it misbehaves |

**The observer watches. The wrapper brackets.** The lifetime notification tells
you a game started, but it fires alongside the launch rather than before it. So
an Action that needs to finish *before* the game reads its files, such as
restoring a save, is racing the game. Lose that race and you silently corrupt
progress, which is the worst possible failure for a save tool.

A wrapper genuinely runs before the process and after it exits. That ordering
guarantee is the only reason a restore-then-play flow is safe.

**Consequence:** an observer-only trigger can safely do the exit half (back up
after the game closes) but not the entry half (restore before it opens).

## Proposed shape

Two triggers, mapped to Modes like every other trigger:

| Trigger | Fires on | Maps to |
|---|---|---|
| **Game start** | a game session begins | game-start mode |
| **Game exit** | a game session ends | game-exit mode |

Both are backed by the observer by default, so they work on the whole library
immediately and touch nothing.

**Pre-launch is opt-in, per game.** A game that needs an Action to complete
before it starts gets a shim injected into its launch options:

```
docky-wrap <appid> -- %command%
```

Docky writes that through `SteamClient.Apps.SetAppLaunchOptions`, which works
with Steam running. The shim calls back into Docky, waits for the game-start Mode
to finish, then executes the game.

Most games never need this. Selecting them is a small per-game list, not a
general launch-option editor.

## Hard constraints

These are not polish. Any one of them, missed, ships a plugin that breaks the
user's library.

### The shim must fail open

It sits in the launch path. If it throws, hangs, cannot reach the backend, or the
plugin was removed with options still injected, **it must still exec the game**.
A wrapper that can prevent a game from starting is worse than no feature. Every
error path ends in "launch the game anyway", and a timeout bounds the wait.

### Injection must merge, never replace

Other plugins write launch options too, and users set their own. Blindly writing
the shim clobbers them. Merging is also not plain concatenation: `docky-wrap` has
to end up the outermost wrapper with `-- %command%` last, so ordering is part of
the merge rule.

### Uninstall must strip what was injected

Config surviving uninstall is a deliberate Docky property, but an injected launch
option is not config, it is a reference to a binary that is about to disappear.
Removal has to clear the shim from every game it was added to.

### Non-Steam games report AppID 0

Custom and non-Steam shortcuts all surface as AppID 0, so per-game config cannot
be keyed on AppID alone.

### The SteamClient surface needs runtime probing

Consistent with the `SliderField` and `TextFieldProps` notes in
[design notes](../design-notes.md), the published types do not reliably describe
what the runtime provides. Both APIs used here need a capability check and a
graceful degrade, not a type-level assumption.

## Why not other approaches

### Why not do everything with the observer and skip the shim

Because restore-before-launch is the half that makes save sync correct, and the
observer cannot provide it. Backup-only is genuinely useful and should ship
first, but calling it complete would leave the race in place.

### Why not inject the save tool's own wrapper directly

Ludusavi already ships a `wrap` subcommand that does backup and restore around a
game, and putting it straight into launch options works today. It is a fine
manual setup, but it hardcodes one tool into the feature. Wrapping with Docky's
own shim makes game start and exit ordinary trigger points, so the save tool
becomes one Action among many and the rest of the Task/Action/Mode model applies
unchanged.

### Why not a generic "inject any wrapper into any game" UI

That is a different plugin. It reaches into Steam's app configuration as an end
in itself, which cuts against the "self-contained panel, not deep integration"
line in [Decky integration](../decky-integration.md). Scoping this to two
triggers, with a shim as the implementation detail that makes pre-launch ordering
possible, keeps the feature inside Docky's existing model.

## Open questions

- Does the shim block on the game-start Mode, or only on Actions explicitly
  marked as blocking? Blocking everything makes a slow Action delay every launch.
- What is the timeout before the shim gives up and launches anyway?
- Does the game-exit Mode fire for a crash, or only a clean exit? Backups
  probably want both.
- Should Modes be selectable per game, or is one global game-start Mode enough
  for the first version?
- The existing triggers share one poll loop. These are event-driven instead, so
  where does that live relative to the trigger watcher?

## Prior art

`decky-renodx` injects per-game launch options through
`SteamClient.Apps.SetAppLaunchOptions` and merges rather than replaces, including
explicit handling to preserve another plugin's wrapper. `PowerTools` uses
`RegisterForAppLifetimeNotifications` for game start and exit. Both are worth
reading before implementing either half.
