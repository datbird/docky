#!/bin/bash
# Remove the Docky plugin (leaves ~/.config/docky intact).
set -euo pipefail
if [[ $EUID -ne 0 ]]; then exec sudo "$0" "$@"; fi
rm -rf "/home/deck/homebrew/plugins/docky"
systemctl restart plugin_loader.service
echo "Removed Docky. Config at ~/.config/docky was left in place."
