# Triggers

A trigger runs a **Mode** automatically when something changes. Each trigger has:

1. An **on/off toggle** in the panel's **Triggers** section, and
2. A **mode mapping** in **gear → Triggers**.

Both are needed: the toggle arms the trigger; the mapping says which Mode to run.

## Available triggers

| Trigger | Fires on | Maps to |
|---|---|---|
| **Dock / undock** | external display / dock connect state changes | docked mode, undocked mode |
| **AC power** | charger connect / disconnect | on-AC mode, on-battery mode |
| **External controller** | a real controller connects / disconnects | connect mode, disconnect mode |
| **Resume** | the Deck wakes from sleep | resume mode |
| **Startup** | Docky loads at boot | startup mode |

## Dock detection

The **Dock / undock** trigger decides "docked" from configurable signals
(gear → Triggers → Dock):

- **Require an external display** (default on) — docked only when a monitor is
  actually connected. This is the most reliable signal.
- Uncheck it to fall back to dock-presence signals: **Require AC power** and/or
  **Require a USB hub**. Each enabled signal is *required* (AND-ed) — enabling
  both means "docked only when AC **and** a USB hub are present," i.e. a real
  dock rather than a bare charger.

The **poll interval** (`pollSeconds`, default 3) controls how often all triggers
are checked. It's clamped to 1–3600 seconds.

## How firing works

- Enabling a trigger **baselines the current state** and only acts on the *next*
  transition — it never fires immediately on enable.
- On a transition, the mapped Mode is activated (its Actions run in order). Mode
  activation runs **off the event loop**, so a long task can't freeze the UI.
- Auto-dock skips a `pcsx2_profile` task while PCSX2 is actively running, so it
  can't clobber a live emulator session.

## Resume detection

The Deck waking from sleep is the one event that doesn't have a simple
poll-the-state signal. Docky detects it by comparing `CLOCK_BOOTTIME` (which
counts time spent suspended) against `CLOCK_MONOTONIC` (which doesn't): a gap
larger than ~20 seconds means the device slept, and the resume Mode runs.

This is the trigger to use for "my settings reset after sleep" — map **Resume**
to a Mode that re-applies your fixes (e.g. force composition + audio output).

## A note on the AC trigger

AC is distinct from dock — you charge undocked all the time. Use the AC trigger
for power-state changes (e.g. set a higher `tdp` on AC, lower on battery)
independent of whether a display is connected.

## Startup

The **Startup** trigger runs a Mode once when Docky loads (i.e. at boot). Handy
for applying a baseline mode every boot. (Sunshine has its own separate
"Start at boot" toggle — see the [Sunshine guide](sunshine.md).)
