# Concepts

Docky is built from four layers. Each is just data you create in the editor.

```
Task    — one atomic operation
Action  — an ordered list of Tasks
Mode    — a named set of Actions
Trigger — an event that activates a Mode
```

Plus **Favorites**, which pin Actions/Modes to the panel for one-tap access.

## Task

The smallest unit of work — apply an audio output, write a file, run a script,
force composition, etc. Tasks have a `type` and type-specific fields. See the
[Task reference](tasks.md) for the full list.

Tasks are configured **at add time** in the editor (gear → Actions → pick an
action → add a "Docky built-in task" or a generic op). Stateful tasks
(composition, built-in controller) take an **On / Off / Toggle** action.

## Action

An ordered list of Tasks that runs top to bottom. By default an Action **stops
at the first failed task**; set `continueOnError` on the action to keep going.

An Action is the unit you **run** (from a Favorite, or as part of a Mode). For
example, a "Dock setup" action might: switch audio to HDMI → disable the
built-in controller → force composition on.

## Mode

A named set of Actions activated together. Activating a Mode runs each of its
Actions in order. Modes are what **Triggers map to** — e.g. "when docked →
`Docked` mode".

Activating a Mode records it as the **active mode** (shown in the panel's info
popup). Modes are also runnable manually (pin one as a Favorite).

## Trigger

An event that activates a Mode automatically. Each trigger is toggled in the
panel's **Triggers** section and mapped to a Mode in **gear → Triggers**:

| Trigger | Event → Mode |
|---|---|
| Dock / undock | docked → *Mode*, undocked → *Mode* |
| AC power | on AC → *Mode*, on battery → *Mode* |
| External controller | connects → *Mode*, disconnects → *Mode* |
| Resume | wake from sleep → *Mode* |
| Startup | Docky loads at boot → *Mode* |

Enabling a trigger **baselines the current state** and only acts on the *next*
change, so it never fires spuriously on enable. See [Triggers](triggers.md).

## Favorite

A pinned Action or Mode shown in the panel's **Favorites** section for one-tap
use. Favorites are ordered (sort them in the editor). A favorite whose underlying
Action has a **stateful** task (e.g. composition) shows a live **on/off LED** and
labels the button by what it does ("Toggle:", "On:", "Off:").

## How it fits together

```
            ┌─ Trigger (dock) ──┐
 you dock ─▶│  → activates Mode │─▶ Mode "Docked"
            └───────────────────┘        │
                                         ├─▶ Action "AV setup"
                                         │      ├─ Task: audio → HDMI
                                         │      └─ Task: composition → on
                                         └─▶ Action "Input setup"
                                                └─ Task: built-in controller → off
```

The same Mode/Action can be triggered automatically *and* pinned as a Favorite
for manual use — they're the same objects.
