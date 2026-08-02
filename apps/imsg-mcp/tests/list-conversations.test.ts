import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getContactsDbPaths, getImsgDbPath } from "../src/config.js";
import { macTimestampToDate } from "../src/db-schema.js";
import { IMessageDB } from "../src/imessage-db.js";
import { isGitLfsPointer } from "./helpers.js";

describe("listConversations", () => {
  it("collapses duplicate chat identifiers into stable visible rows", async () => {
    const limit = 100;
    const chatPath = getImsgDbPath();
    if (isGitLfsPointer(chatPath)) {
      return;
    }

    const raw = new Database(chatPath, { readonly: true });
    const recentChats = raw
      .prepare(`
        SELECT c.chat_identifier
        FROM chat c
        JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
        JOIN message m ON m.ROWID = cmj.message_id
        WHERE m.associated_message_type = 0
          AND COALESCE(m.item_type, 0) = 0
        GROUP BY c.ROWID
        ORDER BY MAX(m.date) DESC
        LIMIT ?
      `)
      .all(limit) as Array<{ chat_identifier: string }>;
    raw.close();

    const duplicateIdentifiers = [
      ...recentChats
        .reduce((acc, row) => {
          acc.set(row.chat_identifier, (acc.get(row.chat_identifier) ?? 0) + 1);
          return acc;
        }, new Map<string, number>())
        .entries(),
    ]
      .filter(([, count]) => count > 1)
      .map(([identifier]) => identifier);

    const tempDir = mkdtempSync(join(tmpdir(), "imsg-slugs-"));
    const slugsPath = join(tempDir, "slugs.db");
    const db = new IMessageDB(chatPath, getContactsDbPaths() ?? undefined, slugsPath);

    try {
      const conversations = await db.listConversations(limit);
      expect(conversations.length).toBeLessThanOrEqual(limit);
      // Synthetic fixtures lack the duplicate-identifier shape that real
      // chat.dbs accumulate (one per service, plus iCloud sync duplicates),
      // so skip the dedup assertion when there's nothing to dedup. The
      // assertion still runs against real DBs in the live-test path.
      if (duplicateIdentifiers.length === 0) return;

      for (const identifier of duplicateIdentifiers) {
        expect(
          conversations.filter((conversation) => conversation.chatIdentifier === identifier).length,
        ).toBeLessThanOrEqual(1);
      }
    } finally {
      await db.close();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("merges duplicate chat rows when the same latest message is linked twice", async () => {
    const limit = 200;
    const chatPath = getImsgDbPath();
    if (isGitLfsPointer(chatPath)) {
      return;
    }

    const raw = new Database(chatPath, { readonly: true });
    const duplicate = raw
      .prepare(`
        WITH latest AS (
          SELECT
            c.chat_identifier,
            c.ROWID as chat_id,
            (
              SELECT m.ROWID
              FROM chat_message_join cmj
              JOIN message m ON m.ROWID = cmj.message_id
              WHERE cmj.chat_id = c.ROWID AND m.associated_message_type = 0
              ORDER BY m.date DESC
              LIMIT 1
            ) as last_message_id,
            (
              SELECT MAX(m.date)
              FROM chat_message_join cmj
              JOIN message m ON m.ROWID = cmj.message_id
              WHERE cmj.chat_id = c.ROWID AND m.associated_message_type = 0
            ) as last_date
          FROM chat c
        )
        SELECT chat_identifier, last_message_id, last_date
        FROM latest
        WHERE last_message_id IS NOT NULL
        GROUP BY chat_identifier, last_message_id, last_date
        HAVING COUNT(*) > 1
        ORDER BY last_date DESC
        LIMIT 1
      `)
      .get() as { chat_identifier: string; last_message_id: number; last_date: number } | undefined;
    raw.close();

    if (!duplicate) {
      return;
    }

    const expectedDate = macTimestampToDate(duplicate.last_date);
    const tempDir = mkdtempSync(join(tmpdir(), "imsg-slugs-"));
    const slugsPath = join(tempDir, "slugs.db");
    const db = new IMessageDB(chatPath, getContactsDbPaths() ?? undefined, slugsPath);

    try {
      const conversations = await db.listConversations(limit);
      const matches = conversations.filter(
        (conversation) =>
          conversation.chatIdentifier === duplicate.chat_identifier &&
          conversation.lastMessageDate?.getTime() === expectedDate?.getTime(),
      );

      expect(matches).toHaveLength(1);
    } finally {
      await db.close();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
