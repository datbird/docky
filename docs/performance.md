# Performance — fan & TDP control

Docky controls the Steam Deck's **fan** and **APU power cap (TDP)** directly from
the Quick Access panel, with reusable **profiles** you can apply manually, from a
task, or automatically from a Mode (e.g. a higher fan curve + more watts when
docked).

> Requires **Decky Loader 3.2.5+** (3.2.6 recommended) on the June 2026 Steam UI.

<table>
  <tr>
    <td valign="top" align="center">
      <img src="images/fan-curve.png" width="300"><br>
      <sub>Fan control — Auto / Curve / Manual, live temp·RPM, editable curve with a live marker</sub>
    </td>
    <td valign="top" align="center">
      <img src="images/tdp.png" width="240"><br>
      <sub>TDP — manual watts, "keep enforced", apply a profile</sub>
    </td>
  </tr>
</table>

## Fan

The panel's **Fan** section (collapsed by default) shows the live temperature and
RPM and lets you pick a mode:

- **Auto** — hand the fan back to SteamOS (its `jupiter-fan-control` daemon).
- **Curve** — a temperature → RPM curve. **Edit fan curve…** opens the editor:
  add/remove points, set each point's temperature and RPM with the steppers, and
  toggle **Smooth** (linear interpolation between points vs. stepped). The graph
  draws the curve with a green dashed line at the current temperature.
- **Manual** — hold a fixed RPM.

Below the modes you can **Apply profile** (a saved fan preset) or **Manage fan
profiles…** (opens the editor's Fan tab).

**How it works:** the Deck fan is driven by writing the target RPM to
`steamdeck_hwmon`'s `fan1_target`. SteamOS's `jupiter-fan-control` daemon rewrites
that value on its own poll, so while a curve or manual speed is active Docky stops
that daemon and a background loop re-applies your target every couple of seconds
(and re-applies after resume-from-sleep). Switching to **Auto** — or unloading the
plugin — restarts the daemon so the fan is never left stuck. Targets are clamped
to a safe ceiling (8000 RPM).

## TDP

The panel's **TDP** section (collapsed by default) shows the current cap and lets
you:

- **Manual TDP (W)** — set a wattage with the stepper and **Apply** it.
- **Apply profile** — apply a saved TDP preset.
- **Keep enforced** — when on, a background loop re-applies your wattage every few
  seconds so Steam's own per-game TDP slider can't override it. Off by default.
- **Manage TDP profiles…** — opens the editor's TDP tab.

**How it works:** the cap is written to amdgpu's `power1_cap` (clamped to the
device's reported min/max). The stock ceiling is **15 W** — going higher requires
an **unlocked BIOS**, which raises `power1_cap_max`; Docky reads that max and lets
the slider reach it. AMD-APU only.

## Profiles

Profiles are named presets, built in the editor's **Fan** and **TDP** tabs
(gear → Fan / TDP):

- A **fan profile** stores a mode (curve/manual/auto), the manual RPM, and the
  curve (points + interpolation).
- A **TDP profile** stores a wattage.

Applying a profile copies it into the active settings and applies it immediately.
You can apply a profile three ways: the panel dropdowns, the `fan` / `tdp`
[tasks](tasks.md) (so a **Mode** can switch performance on dock/undock), or by
saving the current fan setup as a profile from the live **Fan control** editor.

## Hand control back to SteamOS

The **⏏ Hand control back to SteamOS** button at the top of the panel (and the
`release_control` [task](tasks.md)) disables *all* Docky hardware control at once:
fan → Auto and the TDP cap lifted to the hardware default, enforcement off. Use it
to fully return to stock behavior.

## Tasks

These map the controls above onto the Tasks → Actions → Modes model — see the
[task reference](tasks.md#performance):

| type | does |
|---|---|
| `fan` | apply a fan profile (or `auto`) |
| `tdp` | apply a TDP profile, or set inline watts |
| `release_control` | hand fan + TDP back to SteamOS defaults |
