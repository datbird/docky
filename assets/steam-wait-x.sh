#!/bin/bash
# This is the shell script called by the custom "steam.desktop" autostart file.
#
# Steam autostart wrapper — wait for Xwayland/DISPLAY to be ready before launching Steam.
# WHY: when the KDE desktop is started fresh over RDP (KRDP Wayland session), Steam's
# autostart (/etc/xdg/autostart/steam.desktop) can fire before Xwayland/DISPLAY is up and
# loses the race, throwing "Unable to open a connection to X" (steam kb 4050-WOJB-0608).
# This polls until X is actually answerable (or 30s max), then execs the normal Steam launch.
[ -z "$DISPLAY" ] && export DISPLAY=:0
for i in $(seq 1 60); do   # ~30s ceiling (0.5s * 60)
  # kwin_wayland starts Xwayland with a dynamic xauth file under /run/user/<uid>/xauth_*
  if [ -z "$XAUTHORITY" ] || [ ! -r "$XAUTHORITY" ]; then
    xa=$(ls -t /run/user/"$(id -u)"/xauth_* 2>/dev/null | head -1)
    [ -n "$xa" ] && export XAUTHORITY="$xa"
  fi
  if timeout 3 xdpyinfo >/dev/null 2>&1; then
    break   # X is up and answering — safe to launch
  fi
  sleep 0.5
done
exec /usr/bin/steam -silent "$@"
