/**
 * Modal opacity / flexShrink contract.
 *
 * Bug we're locking against: any modal that doesn't explicitly set
 * `backgroundColor` lets the sidebar conversation list (and message
 * pane) bleed through its cells in the live TUI. Same class of bug as
 * the earlier SendViaModal flicker — Ink doesn't fill the background
 * of a Box unless backgroundColor is set, so on screens with other
 * content underneath, the modal looks transparent.
 *
 * We assert via source-text inspection rather than rendering — Ink's
 * test renderer doesn't simulate cell-level overdraw, so a "the modal
 * box has backgroundColor" rendering assertion wouldn't catch the bug
 * even if it existed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MODAL_FILES = [
  "src/tui/components/ComposeRecipientModal.tsx",
  "src/tui/components/SendViaModal.tsx",
  "src/tui/components/DateJumpModal.tsx",
  "src/tui/components/ExportModal.tsx",
];

describe("Modal opacity contract", () => {
  for (const path of MODAL_FILES) {
    it(`${path} sets backgroundColor on the outer Box`, () => {
      const src = readFileSync(path, "utf8");
      // The outer modal Box must include a backgroundColor prop. We allow
      // any theme reference because the exact token may differ per modal.
      expect(src, `${path} missing backgroundColor`).toMatch(/backgroundColor=\{theme\./);
    });

    it(`${path} uses flexShrink={0} discipline`, () => {
      const src = readFileSync(path, "utf8");
      // At least 3 flexShrink={0} occurrences — outer + ≥2 inner rows.
      // (ComposeRecipientModal has 8+, ExportModal/DateJump now have 5+.)
      const count = (src.match(/flexShrink=\{0\}/g) ?? []).length;
      expect(
        count,
        `${path} should have flexShrink={0} on outer + inner rows; got ${count}`,
      ).toBeGreaterThanOrEqual(3);
    });
  }
});
