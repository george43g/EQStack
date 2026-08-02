/**
 * Best-effort Nerd-Font detection.
 *
 * Used by the TUI startup path to warn the user when they've selected the
 * `powerline` glyph preset but no Nerd Font is installed on the system —
 * which would otherwise render as silent blank/box-of-question-mark glyphs.
 *
 * Strategy: run `fc-list :family` (fontconfig). If it's not on PATH we
 * report `unavailable` rather than guessing — the warning is downgraded
 * to a soft hint in that case so we don't false-positive against the many
 * users who do have a Nerd Font but no `fc-list` (default macOS).
 *
 * Synchronous + short timeout so TUI startup isn't gated on a slow shell.
 */

import { spawnSync } from "node:child_process";

export type FontDetectResult =
  | { detected: true; source: "fc-list" }
  | { detected: false; source: "fc-list" }
  | { detected: null; source: "unavailable"; reason: string };

const FC_LIST_TIMEOUT_MS = 1000;

let cached: FontDetectResult | null = null;

/**
 * Returns whether a Nerd Font is installed.
 *
 * `detected: null` means we couldn't tell (no `fc-list`, or it errored).
 * Cached per-process so repeated calls are free.
 */
export function detectNerdFont(): FontDetectResult {
  if (cached) return cached;

  const result = spawnSync("fc-list", [":family"], {
    encoding: "utf8",
    timeout: FC_LIST_TIMEOUT_MS,
    // Suppress stderr noise like "Fontconfig error: ..." from cluttering
    // the user's terminal — we only care about stdout + exit status.
    stdio: ["ignore", "pipe", "ignore"],
  });

  let next: FontDetectResult;
  if (result.error || result.status !== 0) {
    next = {
      detected: null,
      source: "unavailable",
      reason: result.error?.message ?? `fc-list exited with status ${result.status}`,
    };
  } else {
    const stdout = result.stdout ?? "";
    // Match any family name containing "Nerd" (case-insensitive). All Nerd
    // Font patched families include the "Nerd Font" suffix.
    next = { detected: /Nerd/i.test(stdout), source: "fc-list" };
  }
  cached = next;
  return next;
}

/** Test-only: reset the per-process detection cache. */
export function _resetDetectNerdFontCache(): void {
  cached = null;
}
