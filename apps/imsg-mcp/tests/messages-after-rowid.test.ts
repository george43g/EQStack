/**
 * Fixture-backed contract test for IMessageDB.getMessagesAfterRowid — the
 * ChangeWatcher's global delta primitive. Asserts the "one parser, N
 * callers" reuse actually holds: rows come back fully converted (Message
 * shape with classification fields), strictly ascending by ROWID, bounded
 * by the cursor, across ALL chats.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getContactsDbPaths, getImsgDbPath } from "../src/config.js";
import { IMessageDB } from "../src/imessage-db.js";
import { isGitLfsPointer } from "./helpers.js";

const chatPath = getImsgDbPath();
const skip = isGitLfsPointer(chatPath);

describe("IMessageDB.getMessagesAfterRowid", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "imsg-rowid-"));
  const db = skip
    ? null
    : new IMessageDB(chatPath, getContactsDbPaths() ?? undefined, join(tempDir, "slugs.db"));

  afterAll(async () => {
    await db?.close();
  });

  it("returns [] at the current max ROWID (nothing new)", { skip }, async () => {
    const max = db!.getMaxMessageRowId();
    expect(max).toBeGreaterThan(0);
    const rows = await db!.getMessagesAfterRowid(max);
    expect(rows).toEqual([]);
  });

  it("returns converted messages strictly after the cursor, ascending", { skip }, async () => {
    const max = db!.getMaxMessageRowId();
    const cursor = Math.max(0, max - 50);
    const rows = await db!.getMessagesAfterRowid(cursor);
    expect(rows.length).toBeGreaterThan(0);

    let prev = cursor;
    for (const m of rows) {
      expect(m.id).toBeGreaterThan(cursor);
      expect(m.id).toBeGreaterThan(prev);
      prev = m.id;
      // Fully converted Message rows — the fields the bus classifier and
      // TUI renderer rely on.
      expect(typeof m.isFromMe).toBe("boolean");
      expect(typeof m.isReaction).toBe("boolean");
      expect(m.date).toBeInstanceOf(Date);
      expect(typeof m.chatId).toBe("string");
    }
  });

  it("respects the page limit and pages without gaps or dupes", { skip }, async () => {
    const max = db!.getMaxMessageRowId();
    const cursor = Math.max(0, max - 50);
    const all = await db!.getMessagesAfterRowid(cursor);
    if (all.length < 4) return; // fixture too small to page meaningfully

    const pageSize = Math.ceil(all.length / 2);
    const page1 = await db!.getMessagesAfterRowid(cursor, pageSize);
    expect(page1.length).toBeLessThanOrEqual(pageSize);
    const page2 = await db!.getMessagesAfterRowid(page1[page1.length - 1]!.id, pageSize);

    const paged = [...page1, ...page2].map((m) => m.id);
    // Paged walk covers the same prefix of ids with no dupes.
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged).toEqual(all.slice(0, paged.length).map((m) => m.id));
  });

  it("includes from-me rows (the stream carries own-device interjections)", { skip }, async () => {
    // The synthetic fixture interleaves sent/received; scanning a wide
    // window must surface at least one of each so the bus can classify.
    const max = db!.getMaxMessageRowId();
    const rows = await db!.getMessagesAfterRowid(Math.max(0, max - 500));
    expect(rows.some((m) => m.isFromMe)).toBe(true);
    expect(rows.some((m) => !m.isFromMe)).toBe(true);
  });
});
