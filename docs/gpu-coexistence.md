# Streaming and the desktop share one GPU

**Game-Mode streaming (Sunshine → Moonlight)** and the **KDE Desktop Mode you
reach over RDP** both need exclusive control of the *same* GPU. That single fact
is the reason several otherwise-unrelated-looking things live together in Docky:
the Sunshine **GPU handoff** and the **Steam autostart wrapper** are two fixes
for two symptoms of the *one* underlying conflict. This page explains the
conflict, what each piece solves, and how they fit — so you can move between
"couch streaming" and "remote desktop" and have both just work.

If you only want the symptom-and-fix version, see
[Troubleshooting → Switching to Desktop bounces back](troubleshooting.md#switching-to-desktop-mode-bounces-back-to-game-mode)
and [→ Steam "Unable to open a connection to X"](troubleshooting.md#steam-pops-unable-to-open-a-connection-to-x-after-switching-to-desktop).
This page is the *why*.

---

## The root cause: one GPU node, two exclusive owners

The Deck has one render/display device exposed as `/dev/dri/card0`. Owning it to
**drive the display** is exclusive — DRM calls this being the *DRM master*, and
only one process can hold it at a time.

Two different things want that exclusive hold, in two different sessions:

| Session | What holds the GPU | Why |
|---|---|---|
| **Game Mode** | **Sunshine** (`capture=kms`) | KMS screen capture opens `/dev/dri/card0` to grab frames for the Moonlight stream. |
| **Desktop Mode** | **KWin** (KDE's Wayland compositor) | The desktop compositor must be DRM master to render the desktop — and that desktop is exactly what an RDP client shows you. |

You never *want* both at once — you're either streaming from the couch (Game
Mode) or driving the desktop (Desktop Mode). The problem was never "run both."
The problem is the **handoff**: when you switch sessions, the outgoing owner has
to let go of `/dev/dri/card0` before the incoming one can grab it — and nothing
in stock SteamOS coordinates that, because stock SteamOS doesn't run a streaming
host that camps on the GPU in Game Mode.

Because Docky *is* what keeps Sunshine running in Game Mode (see
[Sunshine → Start at boot](sunshine.md#start-at-boot)), coordinating the handoff
is Docky's responsibility.

---

## Problem 1 — switching to Desktop bounced back to Game Mode

**Symptom.** You tap *Switch to Desktop*. Plasma starts, then the whole thing
collapses and dumps you back in Game Mode. Over RDP this looked like "I can't
connect to the desktop" — because the desktop never stayed up long enough to
connect to.

**Why.** Sunshine (autostarted in Game Mode) was still holding `/dev/dri/card0`
when KWin tried to take over. KWin can't get DRM master on a busy node — the
journal shows:

```
kwin_wayland_drm: Failed to open /dev/dri/card0 device (Device or resource busy)
```

so Plasma aborts and SteamOS falls back to Game Mode. Worse, during a losing
switch gamescope **flickers** — it repeatedly tries and fails to grab the GPU
while Sunshine still holds it — and an early version of the handoff read each
flicker as "back in Game Mode" and *restarted* Sunshine, which re-grabbed the
GPU and perpetuated the bounce forever.

**How Docky solves it — the GPU handoff.** A 2-second coexistence loop watches
which session is active and moves the GPU with you:

1. **Leaving Game Mode → free the GPU immediately.** The instant gamescope is no
   longer the compositor, Docky **SIGKILLs Sunshine** (an immediate `force_stop`,
   not a graceful shutdown) so `/dev/dri/card0` is free within ~2 s — inside
   KWin's retry window, so KWin wins the node and the desktop comes up.
2. **Definitive Desktop latch.** As soon as a Plasma session exists
   (`kwin_wayland` / `plasmashell` is running), Sunshine is kept off **no matter
   what** — a gamescope process that flickers during the handoff can't revive it.
   This is what stops the bounce.
3. **Back in Game Mode → restart Sunshine, but only when it's stable.** Sunshine
   is (re)started only after gamescope has been up **continuously for a few
   seconds** and no desktop is present. Stopping is instant; starting is
   debounced — so a flickering, half-bounced transition never restarts Sunshine
   mid-handoff.

The result: switch to Desktop and it stays; switch back to Game Mode and
Moonlight is available again — with no manual "stop Sunshine first" step.

> Shipped across v1.4.0 (the handoff) and v1.4.3 (the latch + debounce that made
> it reliable on a bouncing transition). See the [CHANGELOG](../CHANGELOG.md).

Guardrails, so the handoff can never hurt a stream: Docky **never** stops
Sunshine while Game Mode is up or while a stream is live (`is_streaming()`), and
the coexistence stop uses the low-level stop path so it doesn't count as a
user-requested "off" — Sunshine returns on its own once you're back in Game Mode.

---

## Problem 2 — the desktop came up, but Steam greeted you with an X error

**Symptom.** After the desktop *does* stay up (over RDP especially), a Steam
dialog appears on login: **"Unable to open a connection to X … make sure you
have enabled X"** (Steam support ref `4050-WOJB-0608`).

**Why — same scenario, different race.** This is *not* the GPU conflict; it's a
second thing that only shows up in the exact situation the handoff enables — a
**freshly created Desktop session, typically over RDP**. SteamOS autostarts the
Steam client in Desktop Mode via `/etc/xdg/autostart/steam.desktop`. When the
Plasma **Wayland** session is brand new, Steam can launch a moment *before*
Xwayland / the `DISPLAY` it needs is answerable, lose that race, and error out.
Locally you rarely see it, because X is already warm by the time autostart fires;
a fresh remote desktop is where the timing slips.

**How Docky solves it — the Steam autostart wrapper.** `install.sh` deploys a
**user-level autostart override** that wins over the read-only system copy:

- `~/.config/autostart/steam.desktop` — same filename as the system entry, so
  XDG uses it instead. It launches Steam through the wrapper below.
- `~/.local/bin/steam-wait-x.sh` — polls `xdpyinfo` until X actually answers (a
  30 s ceiling as a fallback), then `exec`s the normal `steam -silent`.

So Steam **waits for the display instead of racing it**. It's a desktop-session
convenience only — it touches nothing in Game Mode, doesn't affect the app-menu
Steam launcher, and lives entirely in the user's home (owned by `deck`, not
root). Remove it with `uninstall.sh` or `rm ~/.config/autostart/steam.desktop`.

> Shipped in v1.4.4. Why it belongs in Docky: it's the *same* Game-Mode ⇄
> Desktop-over-RDP workflow the GPU handoff makes possible — fixing the handoff
> just surfaced the next paper-cut in that flow.

---

## The full picture, both directions

**Game Mode → Desktop (e.g. you switch to Desktop to RDP in):**

1. You switch to Desktop.
2. Docky sees gamescope leave → **SIGKILLs Sunshine** → `/dev/dri/card0` frees.
3. KWin grabs the GPU → Plasma comes up and **stays** (Desktop latch).
4. Steam autostarts → the **wrapper** waits for Xwayland → Steam opens cleanly
   (no X error).
5. *(outside Docky)* `krdpserver` serves the desktop on port 3389 → your RDP
   client connects.

**Desktop → Game Mode (e.g. you're done, back to the couch):**

1. You return to Game Mode.
2. KWin exits → `/dev/dri/card0` frees.
3. gamescope comes up; once it's **stable**, Docky **restarts Sunshine**.
4. Sunshine re-registers its mDNS record (self-healing discovery) → **Moonlight
   finds the Deck and can stream again**.

---

## Who owns what — Docky vs. the RDP side

It's worth being precise, because "RDP into the desktop" involves pieces that are
**not** Docky:

- **Docky's job** is entirely GPU-and-launch coordination on the *streaming*
  side: free `/dev/dri/card0` in time for the desktop, restart Sunshine when
  you're back in Game Mode, keep Sunshine discoverable, and stop Steam from
  faceplanting on X in a fresh desktop. That's the handoff + the wrapper.
- **The desktop/RDP side** — that a KDE session comes up at all, and that
  `krdpserver` is listening on 3389 with your credentials — is KDE/KRDP, driven
  by a small companion set of systemd user units on the Deck (a KRDP watchdog and
  a wait-for-secret gate). Those are deliberately **outside** Docky: they belong
  to the Plasma session, not the Game-Mode plugin, and they run whether or not
  Docky exists.

The two halves meet at exactly one shared resource — `/dev/dri/card0` — which is
why Docky only has to guarantee *"the GPU is free and Steam won't error"* and can
leave *"the desktop is up and RDP is listening"* to the desktop's own machinery.

---

## Design rationale & trade-offs

- **Key the handoff off "is gamescope the compositor," not "detect the
  desktop."** Keying off gamescope-gone means Docky can *never* stop Sunshine
  while Game Mode is up — the safe failure direction (a missed detection leaves
  Moonlight working, it doesn't kill a stream). Detecting Plasma is only used as
  the *latch* that keeps Sunshine off once the desktop has definitively arrived.
- **Stop is an immediate SIGKILL; start is debounced.** Freeing the GPU is
  time-critical (KWin's retry window is only a few seconds), so stopping can't
  wait. Starting is not time-critical and *must* wait, or a flickering transition
  restarts Sunshine into the middle of the handoff — the exact bug v1.4.3 fixed.
- **Solve the contention by not running both, rather than trying to share.**
  Sunshine's KMS capture and KWin genuinely can't share DRM master; there's no
  "share the GPU" option to reach for. One-at-a-time with a fast handoff is the
  only correct model.
- **Fix Steam with an autostart *override + wrapper*, not by editing the system
  file.** `/etc/xdg/autostart/steam.desktop` is on the read-only SteamOS root; a
  user-level override at the same path is the supported, update-safe way to change
  it, and a wrapper keeps the change to "wait, then launch the normal command"
  rather than reimplementing Steam's launch.
- **Keep the desktop/RDP units out of Docky.** They're desktop-session concerns
  that must work independently of a Game-Mode plugin; coupling them to Docky would
  make remote desktop depend on a Decky plugin being loaded.

See [Design notes](design-notes.md) for the rest of Docky's accepted trade-offs.
