#!/usr/bin/env bash
# Capture: Quick Look panel previewing an image attachment.
# Requires: Screen Recording permission (for screencapture -W).
# Idempotent: kills any prior qlmanage before launching ours.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$REPO_ROOT/docs/screenshots/native/quicklook-image.png"
mkdir -p "$(dirname "$OUT")"

# Pick a stable sample image — prefer one of the fixture attachments if
# present, else fall back to a built-in macOS asset.
SAMPLE=""
for candidate in \
  "$REPO_ROOT/env-data/sample-attachment.jpg" \
  "$REPO_ROOT/fixtures/sample-attachment.jpg" \
  "/System/Library/CoreServices/DefaultDesktop.heic" \
  "/Library/Desktop Pictures/Solid Colors/Stone.png"; do
  if [[ -f "$candidate" ]]; then
    SAMPLE="$candidate"
    break
  fi
done

if [[ -z "$SAMPLE" ]]; then
  echo "ERROR: no sample image found. Add one at env-data/sample-attachment.jpg" >&2
  exit 1
fi

echo "→ capturing Quick Look preview of: $SAMPLE"

# Kill any stale qlmanage so the new one is the focused window.
pkill -x qlmanage 2>/dev/null || true

# Launch Quick Look in panel mode. -p shows a single file in a window.
qlmanage -p "$SAMPLE" >/dev/null 2>&1 &
QL_PID=$!

# Give Quick Look time to render
sleep 1.5

# Capture the front-most window (the QL panel). -W = wait + capture window
# under the user's mouse — but for unattended runs we want the active
# window without prompting, so use -l<windowId>. We can find the QL window
# id via osascript.
WIN_ID=$(osascript -e 'tell application "System Events" to tell process "qlmanage" to get id of front window' 2>/dev/null || echo "")

if [[ -n "$WIN_ID" ]]; then
  screencapture -o -l"$WIN_ID" "$OUT"
else
  # Fallback: capture the whole screen, user can crop manually.
  echo "  (could not resolve qlmanage window id; capturing full screen)"
  screencapture -o "$OUT"
fi

# Clean up
kill "$QL_PID" 2>/dev/null || true
pkill -x qlmanage 2>/dev/null || true

echo "✓ wrote $OUT"
