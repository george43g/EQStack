/**
 * Last-message-per-chat semantics.
 *
 * `getLastMessageByChat` (behind listConversations) was a
 * `ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY date DESC)` over the whole
 * message table — its plan was a full `SCAN m` plus `USE TEMP B-TREE FOR ORDER
 * BY`, and it was the single largest cost in TUI boot (1213ms of ~1.8s on a
 * 407,998-message / 4,790-chat database).
 *
 * It is now a `MAX(m.date)` aggregate grouped by chat, relying on SQLite's
 * documented guarantee that with a single min()/max() aggregate, bare columns
 * take their values from the row that produced the extreme. Same results
 * (verified: 0 date mismatches, 0 ties resolved differently), ~3.2x faster.
 *
 * These tests pin the SEMANTICS the rewrite has to preserve, on a fixture built
 * so that date order and ROWID order disagree — the case a naive "just take the
 * highest ROWID" implementation would pass by accident.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";

const MAC_EPOCH_OFFSET = 978_307_200;
const NANOS = 1_000_000_000;
const macNanos = (d: Date) => Math.floor((d.getTime() / 1000 - MAC_EPOCH_OFFSET) * NANOS);

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const PHONE_A = "+15550001111";
const PHONE_B = "+15550002222";
const PHONE_EMPTY = "+15550003333";

function makeFixture(): { chatDb: string; slugsDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-lastmsg-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const slugsDb = join(dir, "slugs.db");
  const cd = new Database(chatDb);
  cd.exec(`
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
      style INTEGER, state INTEGER, account_id TEXT, properties BLOB,
      chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT,
      is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT,
      group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER,
      last_read_message_timestamp INTEGER DEFAULT 0
    );
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT,
      service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service)
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0,
      attributedBody BLOB, type INTEGER DEFAULT 0, service TEXT, error INTEGER DEFAULT 0,
      date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0,
      is_from_me INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0,
      associated_message_emoji TEXT, balloon_bundle_id TEXT, payload_data BLOB, message_summary_info BLOB,
      reply_to_guid TEXT, thread_originator_guid TEXT, thread_originator_part TEXT,
      date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0, is_edited INTEGER DEFAULT 0
    );
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
    CREATE TABLE chat_message_join (
      chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT,
      total_bytes INTEGER, created_date INTEGER, is_sticker INTEGER DEFAULT 0, uti TEXT
    );
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);

  let handleRow = 0;
  let chatRow = 0;
  const addChat = (phone: string) => {
    handleRow++;
    chatRow++;
    cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, 'iMessage')").run(
      handleRow,
      phone,
    );
    cd.prepare(
      "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (?, ?, ?, 'iMessage', 45)",
    ).run(chatRow, `iMessage;-;${phone}`, phone);
    cd.prepare("INSERT INTO chat_handle_join VALUES (?, ?)").run(chatRow, handleRow);
    return chatRow;
  };

  const addMsg = (
    chatId: number,
    id: number,
    text: string,
    d: Date,
    opts: { assoc?: number; itemType?: number; fromMe?: 0 | 1; service?: string } = {},
  ) => {
    cd.prepare(
      `INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, service,
         associated_message_type, item_type)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      `g-${id}`,
      text,
      macNanos(d),
      opts.fromMe ?? 0,
      opts.service ?? "iMessage",
      opts.assoc ?? 0,
      opts.itemType ?? 0,
    );
    cd.prepare("INSERT INTO chat_message_join VALUES (?, ?, ?)").run(chatId, id, macNanos(d));
  };

  const chatA = addChat(PHONE_A);
  const chatB = addChat(PHONE_B);
  addChat(PHONE_EMPTY); // no messages at all

  // Chat A — date order DISAGREES with ROWID order. The newest message by date
  // carries the LOWEST rowid, so anything keying off ROWID picks the wrong one.
  addMsg(chatA, 500, "newest by date, lowest rowid", new Date("2026-01-05T00:00:00Z"), {
    fromMe: 1,
    service: "SMS",
  });
  addMsg(chatA, 600, "middle", new Date("2025-06-01T00:00:00Z"));
  addMsg(chatA, 700, "oldest by date, highest rowid", new Date("2024-01-01T00:00:00Z"));

  // Rows that must NOT count as "last", both newer than every real message:
  addMsg(chatA, 800, "a tapback", new Date("2026-02-01T00:00:00Z"), { assoc: 2000 });
  addMsg(chatA, 900, "joined the conversation", new Date("2026-03-01T00:00:00Z"), { itemType: 1 });

  // Chat B — plain, older than chat A, to pin ordering between chats.
  addMsg(chatB, 100, "chat B latest", new Date("2025-01-01T00:00:00Z"));
  addMsg(chatB, 200, "chat B older", new Date("2024-01-01T00:00:00Z"));

  cd.close();
  return { chatDb, slugsDb };
}

describe("last message per chat", () => {
  it("picks the newest by DATE even when it has the lowest ROWID", async () => {
    const { chatDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const convs = await db.listConversations(50);
      const a = convs.find((c) => c.chatIdentifier === PHONE_A);
      expect(a).toBeDefined();
      expect(a?.lastMessageDate?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    } finally {
      await db.close();
    }
  });

  it("ignores tapbacks and system rows when choosing the last message", async () => {
    const { chatDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const convs = await db.listConversations(50);
      const a = convs.find((c) => c.chatIdentifier === PHONE_A);
      // The tapback (2026-02) and the join event (2026-03) are both newer than
      // the real last message — neither may win.
      expect(a?.lastMessageDate?.getUTCFullYear()).toBe(2026);
      expect(a?.lastMessageDate?.getUTCMonth()).toBe(0); // January, not Feb/Mar
    } finally {
      await db.close();
    }
  });

  it("orders conversations by their last real message, newest first", async () => {
    const { chatDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const convs = await db.listConversations(50);
      const idents = convs.map((c) => c.chatIdentifier);
      expect(idents.indexOf(PHONE_A)).toBeLessThan(idents.indexOf(PHONE_B));
    } finally {
      await db.close();
    }
  });

  it("keeps a chat with no messages, with no last date", async () => {
    const { chatDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const convs = await db.listConversations(50);
      const empty = convs.find((c) => c.chatIdentifier === PHONE_EMPTY);
      expect(empty).toBeDefined();
      expect(empty?.lastMessageDate).toBeNull();
    } finally {
      await db.close();
    }
  });
});
