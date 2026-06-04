#!/usr/bin/env bash
# Best-effort drift report for the regenerated screenshots.
#
# Pre-2025 we tried a blocking `git diff --exit-code` gate, but VHS's
# encoder isn't byte-deterministic — repeated runs of the same tape
# produce visually-identical PNGs with different hashes (font subpixel
# rendering, cursor blink phase, frame timing). The gate flapped enough
# that the signal-to-noise hurt more than the drift detection helped.
#
# Today we just *list* the regenerated files that differ from the
# committed baseline and always exit 0. The CI workflow's push branch
# auto-commits any drift with [skip ci] so the gallery stays current; the
# PR-mode workflow runs this same script and surfaces the diff in its
# log without blocking the build.
#
# If you want a hard gate locally, replace this script with a `git diff
# --exit-code -- 'docs/screenshots/*.png'` call.

set -euo pipefail

DRIFT=$(git status --porcelain -- docs/screenshots/ | awk '$1 ~ /^M$|^\?\?$/ {print $2}' || true)

if [[ -z "$DRIFT" ]]; then
  echo "✓ screenshots in sync."
  exit 0
fi

echo "ℹ screenshots regenerated. The following files differ from the committed baseline:"
echo ""
git status --short -- docs/screenshots/
echo ""
echo "If the visual content is intentionally different (TUI source / fixture / tape changed)"
echo "commit the new outputs. If the PNG content looks identical to the committed one, the"
echo "drift is VHS encoder jitter — safe to ignore."
exit 0
