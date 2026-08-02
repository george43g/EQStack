/**
 * Bounded message cache — stress test against the synthetic stress
 * fixture (>5000-message thread).
 *
 * Skips unless `fixtures-stress/chat.db` is present (generated via
 * `pnpm fixtures:stress`). When it runs, this is the only test in the
 * suite that exercises the bounded-window pipeline end-to-end against
 * tens of thousands of real-shaped rows — not the synthetic `fakeMsgs`
 * fixture in bounded-memory-window.test.ts.
 *
 * Asserts:
 *   - getMessagesForChat returns >5000 rows for a top-heavy stress chat
 *   - boundMessagesIfNeeded caps the array and emits the expected
 *     gap marker between the cursor window and the anchor region
 *   - the cursor's logical message survives the bounding round-trip
 *   - the messageCache stores + returns the bounded array unchanged
 *   - heap growth from the entire pipeline stays well under 200MB
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";
import {
  clearCache,
  getCached,
  installCacheSweepers,
  setCached,
  stopCacheSweepers,
} from "../src/tui/messageCache.js";
import { boundMessagesIfNeeded } from "../src/tui/types.js";
import { isGitLfsPointer } from "./helpers.js";

const STRESS_DB = "fixtures-stress/chat.db";
const STRESS_AB = "fixtures-stress/AddressBook";
const HARD_CAP = 5000;

function stressFixturePresent(): boolean {
  return existsSync(STRESS_DB) && !isGitLfsPointer(STRESS_DB);
}

describe("Bounded cache stress (>5000-msg thread)", () => {
  beforeEach(() => {
    installCacheSweepers();
    clearCache();
    if (global.gc) global.gc();
  });

  afterEach(() => {
    stopCacheSweepers();
    clearCache();
  });

  it("caps messages, places gap markers, preserves cursor, and bounds heap", async () => {
    if (!stressFixturePresent()) {
      // No stress fixture on this machine — skip silently. CI / dev runs
      // can generate one with `pnpm fixtures:stress`.
      return;
    }

    const heapStart = process.memoryUsage().heapUsed;

    const tempDir = mkdtempSync(join(tmpdir(), "imsg-stress-"));
    const slugsPath = join(tempDir, "slugs.db");
    const contacts = existsSync(STRESS_AB) ? [STRESS_AB] : undefined;
    const db = new IMessageDB(STRESS_DB, contacts, slugsPath);

    try {
      // Find a chat with > HARD_CAP messages. Top-heavy preset puts 20k
      // each on the top 5 chats — listConversations(50) is plenty.
      const convs = await db.listConversations(50);
      const candidates: { id: string; count: number }[] = [];
      for (const c of convs) {
        // Cheap probe: ask for HARD_CAP+10 rows and count what comes back.
        const sample = await db.getMessagesForChat(c.chatIdentifier, HARD_CAP + 10);
        if (sample.length > HARD_CAP) {
          candidates.push({ id: c.chatIdentifier, count: sample.length });
          break; // one is enough — we just need a single hot thread
        }
      }
      if (candidates.length === 0) {
        // Stress fixture exists but no top-heavy chat — should not happen
        // under the default preset, but skip gracefully if a user has
        // regenerated with a different shape.
        return;
      }

      const hot = candidates[0];
      // Load substantially more than the cap to exercise the eviction path.
      const target = Math.max(hot.count + 100, HARD_CAP * 2);
      const messages = await db.getMessagesForChat(hot.id, target);
      expect(messages.length).toBeGreaterThan(HARD_CAP);

      // Place the cursor deep in history so the cursor window and the
      // recent-anchor region are non-overlapping → exactly one gap marker.
      const cursorIdx = 100;
      const cursorMsgId = messages[cursorIdx].id;

      const bounded = boundMessagesIfNeeded(messages, cursorIdx, []);

      // Cap: bounded array must be smaller than original. Kept regions:
      //   cursor window = cursorIdx ± 300 = 401 messages
      //   anchor        = last 200 messages
      // Non-overlapping when cursor is deep in history, so ≈601 total.
      expect(bounded.messages.length).toBeLessThan(messages.length);
      expect(bounded.messages.length).toBeGreaterThanOrEqual(600);
      expect(bounded.messages.length).toBeLessThan(HARD_CAP);

      // Exactly one gap between the two kept regions.
      expect(bounded.gapMarkers).toHaveLength(1);
      expect(bounded.gapMarkers[0].count).toBeGreaterThan(0);

      // Cursor's logical message survives the round-trip.
      expect(bounded.selectedMsgIdx).toBeGreaterThanOrEqual(0);
      expect(bounded.messages[bounded.selectedMsgIdx].id).toBe(cursorMsgId);

      // Cache round-trip: storing + retrieving doesn't mutate the array.
      setCached(hot.id, bounded.messages, bounded.messages[0].id);
      const fromCache = getCached(hot.id);
      expect(fromCache).toBeDefined();
      expect(fromCache?.messages.length).toBe(bounded.messages.length);
      expect(fromCache?.messages[bounded.selectedMsgIdx].id).toBe(cursorMsgId);

      // Heap bound: a single bounded chat + cache entry should not push
      // heap growth past 200MB. The pipeline allocates an intermediate
      // unbounded array temporarily; we measure after that's collectible.
      messages.length = 0; // drop the original array
      if (global.gc) global.gc();
      const heapEnd = process.memoryUsage().heapUsed;
      const growthMb = (heapEnd - heapStart) / 1024 / 1024;
      expect(growthMb).toBeLessThan(200);
    } finally {
      await db.close();
    }
  }, 30_000);
});
