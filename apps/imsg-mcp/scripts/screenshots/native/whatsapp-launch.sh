#!/usr/bin/env bash
# Capture: WhatsApp launched via URL scheme with a phone pre-filled.
# Requires: Screen Recording permission. WhatsApp must be installed.
# Skips gracefully if WhatsApp is not installed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$REPO_ROOT/docs/screenshots/native/whatsapp-launch.png"
mkdir -p "$(dirname "$OUT")"

if [[ ! -d "/Applications/WhatsApp.app" ]]; then
  echo "⚠ WhatsApp not installed at /Applications/WhatsApp.app — skipping" >&2
  exit 0
fi

echo "→ launching WhatsApp via URL scheme"
open "whatsapp://send?phone=15555550100"

# Give the app time to come to the foreground
sleep 2.5

WIN_ID=$(osascript -e 'tell application "System Events" to tell process "WhatsApp" to get id of front window' 2>/dev/null || echo "")

if [[ -n "$WIN_ID" ]]; then
  screencapture -o -l"$WIN_ID" "$OUT"
else
  echo "  (could not resolve WhatsApp window id; capturing full screen)"
  screencapture -o "$OUT"
fi

echo "✓ wrote $OUT"
echo "  (WhatsApp left open — close it manually when done reviewing)"
