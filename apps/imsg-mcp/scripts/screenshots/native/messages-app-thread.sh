#!/usr/bin/env bash
# Capture: Messages.app thread opened via imessage:// URL scheme.
# Requires: Screen Recording permission, Messages.app signed in.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$REPO_ROOT/docs/screenshots/native/messages-app-thread.png"
mkdir -p "$(dirname "$OUT")"

if [[ ! -d "/System/Applications/Messages.app" ]] && [[ ! -d "/Applications/Messages.app" ]]; then
  echo "⚠ Messages.app not found — skipping" >&2
  exit 0
fi

echo "→ opening Messages.app via imessage:// URL scheme"
# Use the fictional +1-555-01xx range so we don't accidentally text a real
# number when running this capture.
open "imessage://+15555550100"

sleep 2.5

WIN_ID=$(osascript -e 'tell application "System Events" to tell process "Messages" to get id of front window' 2>/dev/null || echo "")

if [[ -n "$WIN_ID" ]]; then
  screencapture -o -l"$WIN_ID" "$OUT"
else
  echo "  (could not resolve Messages window id; capturing full screen)"
  screencapture -o "$OUT"
fi

echo "✓ wrote $OUT"
