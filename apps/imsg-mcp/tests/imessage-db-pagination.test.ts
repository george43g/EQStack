/**
 * Pagination contract: getMessagesForChat with `beforeMessageId` returns
 * messages strictly older than the boundary in (date, ROWID) order — NOT by
 * ROWID alone. Restored/merged threads reorder ROWIDs, so an older-date message
 * can have a higher ROWID; paginating by the cursor's date is what covers the
 * whole history with no gaps and no duplicates. The cursor is the oldest id of
 * the previous page (getMessagesForChat returns date-ascending, so page[0]).
 *
 * Uses the env-data fixture (committed chat.db). Skips gracefully if the
 * fixture isn't available (e.g. fresh clone without LFS pull).
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } from "../src/config.js";
import { IMessageDB } from "../src/imessage-db.js";

const dbPath = getImsgDbPath();
const haveFixture = existsSync(dbPath);

describe.skipIf(!haveFixture)("getMessagesForChat pagination", () => {
  it("returns messages strictly older (by date, ROWID) than the boundary", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      const convs = await db.listConversations(50);
      // Find a conversation with at least 50 messages
      let target: string | null = null;
      for (const c of convs) {
        const msgs = await db.getMessagesForChat(c.chatIdentifier, 100);
        if (msgs.length >= 50) {
          target = c.chatIdentifier;
          break;
        }
      }
      expect(target, "no conversation in fixture has ≥50 messages").not.toBeNull();
      if (!target) return;

      // Take the most recent 30; the boundary is the oldest of those (page[0],
      // since results are date-ascending) — that's the pagination cursor.
      const recent = await db.getMessagesForChat(target, 30);
      const boundary = recent[0];

      const older = await db.getMessagesForChat(target, 30, { beforeMessageId: boundary.id });
      expect(older.length).toBeGreaterThan(0);
      for (const m of older) {
        const strictlyOlder =
          m.date.getTime() < boundary.date.getTime() ||
          (m.date.getTime() === boundary.date.getTime() && m.id < boundary.id);
        expect(strictlyOlder).toBe(true);
      }
    } finally {
      await db.close();
    }
  });

  it("paginated fetch yields no duplicates between pages", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      const convs = await db.listConversations(50);
      let target: string | null = null;
      for (const c of convs) {
        const msgs = await db.getMessagesForChat(c.chatIdentifier, 100);
        if (msgs.length >= 50) {
          target = c.chatIdentifier;
          break;
        }
      }
      if (!target) return;

      const page1 = await db.getMessagesForChat(target, 20);
      // Cursor = oldest by date (page[0]), the value the handler paginates with.
      const cursor = page1[0].id;
      const page2 = await db.getMessagesForChat(target, 20, { beforeMessageId: cursor });

      const idsPage1 = new Set(page1.map((m) => m.id));
      for (const m of page2) {
        expect(idsPage1.has(m.id)).toBe(false);
      }
    } finally {
      await db.close();
    }
  });

  it("returns an empty array when paginating before the oldest message", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      const convs = await db.listConversations(50);
      // Find a conversation small enough to fetch whole, so page[0] is the TRUE
      // oldest by date (not just the oldest of a capped window).
      const LIM = 5000;
      for (const c of convs) {
        const all = await db.getMessagesForChat(c.chatIdentifier, LIM);
        if (all.length === 0 || all.length >= LIM) continue;
        const oldest = all[0]; // date-ascending → global oldest
        const older = await db.getMessagesForChat(c.chatIdentifier, 50, {
          beforeMessageId: oldest.id,
        });
        expect(older.length).toBe(0);
        return;
      }
    } finally {
      await db.close();
    }
  });

  it("getMessagesAfter fetches incoming messages beyond the latest window", async () => {
    const db = new IMessageDB(dbPath, getContactsDbPaths(), getSlugsDbPath());
    try {
      const convs = await db.listConversations(50);
      for (const c of convs) {
        const msgs = await db.getMessagesForChat(c.chatIdentifier, 1200);
        const incoming = msgs.filter((m) => !m.isFromMe);
        if (incoming.length < 2) continue;

        const boundaryMsg = incoming[0];
        const after = await db.getMessagesAfter(c.chatIdentifier, boundaryMsg.id);
        // "After" is composite (date, ROWID) order, not bare id order: a
        // message received offline can land with a LOWER ROWID and a later
        // date and must still be returned (wait_for_reply depends on it).
        for (const m of after) {
          expect(m.isFromMe).toBe(false);
          expect(m.id).not.toBe(boundaryMsg.id);
          const strictlyLater =
            m.date.getTime() > boundaryMsg.date.getTime() ||
            (m.date.getTime() === boundaryMsg.date.getTime() && m.id > boundaryMsg.id);
          expect(strictlyLater).toBe(true);
        }
        const dates = after.map((m) => m.date.getTime());
        expect(dates).toEqual([...dates].sort((a, b) => a - b));
        return;
      }
    } finally {
      await db.close();
    }
  });
});
