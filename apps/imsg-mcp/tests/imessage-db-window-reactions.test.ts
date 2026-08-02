/**
 * Regression: `getMessagesInWindow` must populate enough of the `ext`
 * object that `convertMessage` can detect reactions / edits / replies
 * via `associated_message_type`, `date_edited`, `thread_originator_guid`.
 *
 * Pre-fix bug: the SELECT was wide enough but the `ext` object was
 * `{ item_type: r.item_type }` only. Every row arrived in analytics as
 * `isReaction: false`, so `tapback_summary` returned `[]` and
 * `year_in_review_wrapped.totalReactions` was always 0 — regardless of
 * how many reactions the user actually had.
 *
 * This test builds a tiny synthetic chat.db with one normal message and
 * one LOVE_ADD reaction, then asserts the reaction is round-tripped
 * through the analytics-feeding query.
 */

import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";

const FIXTURE = "fixtures/chat.db";
const haveFixture = existsSync(FIXTURE);

describe.skipIf(!haveFixture)("getMessagesInWindow includes reaction context", () => {
  let workDir: string;
  let dbPath: string;
  let slugsPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "imsg-rxn-"));
    dbPath = join(workDir, "chat.db");
    slugsPath = join(workDir, "slugs.db");
    // Copy the synthetic fixture so we don't pollute the committed file.
    copyFileSync(FIXTURE, dbPath);
  });

  afterEach(() => {
    // Tempdir leak is harmless; OS reclaims.
  });

  it("returns isReaction=true + parsed reaction for a LOVE_ADD row", async () => {
    // Inject a reaction row into the copy. We piggyback on whatever the
    // first existing message in the fixture is (target_guid + chat link).
    const sqlite = new Database(dbPath);
    const target = sqlite
      .prepare("SELECT ROWID, guid FROM message WHERE associated_message_type = 0 LIMIT 1")
      .get() as { ROWID: number; guid: string } | undefined;
    expect(target, "fixture has no normal messages to react to").toBeDefined();
    if (!target) {
      sqlite.close();
      return;
    }

    // Use a very-recent date (latest in fixture + 1 second) so the
    // analytics window we query below will definitely include it.
    const latestRow = sqlite.prepare("SELECT COALESCE(MAX(date), 0) AS d FROM message").get() as {
      d: number;
    };
    const reactionDateNs = Number(latestRow.d) + 1_000_000_000;

    const reactionGuid = "test-reaction-guid-deadbeef";
    const associatedGuid = `p:0/${target.guid}`;

    sqlite
      .prepare(`
        INSERT INTO message (
          guid, text, handle_id, date, is_from_me, is_read, is_delivered,
          service, item_type, associated_message_type, associated_message_guid,
          cache_has_attachments
        ) VALUES (?, ?, NULL, ?, 0, 1, 1, 'iMessage', 0, 2000, ?, 0)
      `)
      .run(reactionGuid, "Loved a message", reactionDateNs, associatedGuid);

    const reactionRowId = Number(
      (sqlite.prepare("SELECT last_insert_rowid() AS r").get() as { r: number }).r,
    );

    // Link reaction to the same chat the target message lives in.
    const targetChat = sqlite
      .prepare("SELECT chat_id FROM chat_message_join WHERE message_id = ? LIMIT 1")
      .get(target.ROWID) as { chat_id: number } | undefined;
    if (targetChat) {
      sqlite
        .prepare(
          "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
        )
        .run(targetChat.chat_id, reactionRowId, reactionDateNs);
    }
    sqlite.close();

    const db = new IMessageDB(dbPath, undefined, slugsPath);
    try {
      // Window from epoch → present so we definitely cover the injected row.
      const msgs = await db.getMessagesInWindow(0);
      const reaction = msgs.find((m) => m.guid === reactionGuid);
      expect(reaction, "injected reaction was not returned by getMessagesInWindow").toBeDefined();
      expect(reaction?.isReaction).toBe(true);
      expect(reaction?.reaction).toBeDefined();
      expect(reaction?.reaction?.type).toBe("love");
      expect(reaction?.reaction?.targetMessageGuid).toBe(target.guid);
    } finally {
      await db.close();
    }
  });

  it("sets isEdited when date_edited is present", async () => {
    const sqlite = new Database(dbPath);
    const editedGuid = "test-edited-guid-cafecafe";
    sqlite
      .prepare(`
        INSERT INTO message (
          guid, text, handle_id, date, date_edited, is_from_me, is_read, is_delivered,
          service, item_type, associated_message_type, cache_has_attachments
        ) VALUES (?, 'edited message', NULL, ?, ?, 0, 1, 1, 'iMessage', 0, 0, 0)
      `)
      .run(editedGuid, 1000000000, 2000000000);
    sqlite.close();

    const db = new IMessageDB(dbPath, undefined, slugsPath);
    try {
      const msgs = await db.getMessagesInWindow(0);
      const edited = msgs.find((m) => m.guid === editedGuid);
      expect(edited, "injected edited message not returned").toBeDefined();
      expect(edited?.isEdited).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("returns ASC by date and a capped load keeps the MOST RECENT window", async () => {
    // Insert 6 messages at strictly increasing dates, then cap to 3.
    const sqlite = new Database(dbPath);
    const chatRow = sqlite.prepare("SELECT chat_id FROM chat_message_join LIMIT 1").get() as
      | { chat_id: number }
      | undefined;
    const base = 900_000_000_000_000_000; // far future ns so these sort last
    for (let i = 0; i < 6; i++) {
      const guid = `ordertest-${i}`;
      const date = base + i * 1_000_000_000;
      sqlite
        .prepare(`
          INSERT INTO message (guid, text, handle_id, date, is_from_me, is_read,
            is_delivered, service, item_type, associated_message_type, cache_has_attachments)
          VALUES (?, ?, NULL, ?, 0, 1, 1, 'iMessage', 0, 0, 0)
        `)
        .run(guid, `msg ${i}`, date);
      const rid = Number(
        (sqlite.prepare("SELECT last_insert_rowid() AS r").get() as { r: number }).r,
      );
      if (chatRow) {
        sqlite
          .prepare(
            "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
          )
          .run(chatRow.chat_id, rid, date);
      }
    }
    sqlite.close();

    const db = new IMessageDB(dbPath, undefined, slugsPath);
    try {
      // Cap to 3 over a window that starts just before our 6 messages.
      const cutoffMs = (base / 1_000_000_000 + 978_307_200) * 1000 - 60_000;
      const msgs = await db.getMessagesInWindow(cutoffMs, 3);
      const ours = msgs.filter((m) => m.guid.startsWith("ordertest-"));
      // Cap keeps the most recent 3 (indices 3,4,5), returned oldest→newest.
      expect(ours.map((m) => m.guid)).toEqual(["ordertest-3", "ordertest-4", "ordertest-5"]);
      // Global ordering is ascending by date.
      for (let i = 1; i < msgs.length; i++) {
        expect(msgs[i].date.getTime()).toBeGreaterThanOrEqual(msgs[i - 1].date.getTime());
      }
    } finally {
      await db.close();
    }
  });
});
