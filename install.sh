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

echo "Restarting Decky plugin loader..."
systemctl restart plugin_loader.service
echo "Done. Game Mode -> Quick Access -> Decky -> 'Docky'."
