#!/bin/bash
# Install/update the Docky Decky plugin.  Run from the repo root:  sudo ./install.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="/home/deck/homebrew/plugins/docky"
OLD="/home/deck/homebrew/plugins/retrodeck-pad-profiles"

if [[ $EUID -ne 0 ]]; then echo "Re-running with sudo..."; exec sudo "$0" "$@"; fi

# Docky supersedes the standalone PCSX2 plugin; remove it if present.
if [[ -d "$OLD" ]]; then echo "Removing superseded plugin: $OLD"; rm -rf "$OLD"; fi

echo "Installing $SRC -> $DEST"
rm -rf "$DEST"
mkdir -p "$DEST/dist" "$DEST/py_modules"
install -m 0644 "$SRC/main.py"                "$DEST/main.py"
install -m 0644 "$SRC/plugin.json"            "$DEST/plugin.json"
install -m 0644 "$SRC/package.json"           "$DEST/package.json"
install -m 0644 "$SRC/dist/index.js"          "$DEST/dist/index.js"
# Copy every backend module so adding a new py_module can't silently break installs.
for mod in "$SRC"/py_modules/*.py; do
  install -m 0644 "$mod" "$DEST/py_modules/$(basename "$mod")"
done
[[ -f "$SRC/README.md" ]] && install -m 0644 "$SRC/README.md" "$DEST/README.md" || true

chown -R root:root "$DEST"
chmod -R go+rX "$DEST"

# --- Desktop-session assets (run in the KDE session, NOT inside the plugin sandbox) ---
# Steam's desktop autostart (/etc/xdg/autostart/steam.desktop) races Xwayland on a fresh
# RDP login and errors "Unable to open a connection to X". Ship a user-level override that
# routes Steam's autostart through a wrapper which waits for X first. Owned by `deck`, not
# root, since they live in the user's home. See docs/sunshine.md.
DECK_HOME="/home/deck"
install -d -o deck -g deck "$DECK_HOME/.local/bin" "$DECK_HOME/.config/autostart"
install -o deck -g deck -m 0755 "$SRC/assets/steam-wait-x.sh"         "$DECK_HOME/.local/bin/steam-wait-x.sh"
install -o deck -g deck -m 0644 "$SRC/assets/steam-autostart.desktop" "$DECK_HOME/.config/autostart/steam.desktop"
echo "Installed Steam autostart X-wait fix (~/.local/bin/steam-wait-x.sh, ~/.config/autostart/steam.desktop)."

echo "Restarting Decky plugin loader..."
systemctl restart plugin_loader.service
echo "Done. Game Mode -> Quick Access -> Decky -> 'Docky'."
