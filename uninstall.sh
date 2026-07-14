#!/bin/bash
# Remove the Docky plugin (leaves ~/.config/docky intact).
set -euo pipefail
if [[ $EUID -ne 0 ]]; then exec sudo "$0" "$@"; fi
rm -rf "/home/deck/homebrew/plugins/docky"
# Remove the desktop-session Steam autostart override (restores the stock system autostart).
rm -f "/home/deck/.config/autostart/steam.desktop" "/home/deck/.local/bin/steam-wait-x.sh"
systemctl restart plugin_loader.service
echo "Removed Docky (+ Steam autostart override). Config at ~/.config/docky was left in place."
