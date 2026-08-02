/**
 * Send-failure awareness:
 *  1. Failed from-me messages carry `sendError` (chat.db `error` code) so the
 *     TUI/MCP can render "not delivered" instead of a normal sent bubble.
 *  2. getPreferredSendService judges a thread's REAL service by delivery
 *     evidence — received messages and error-free sends — so one failed
 *     wrong-service attempt (which mints a phantom leg and can flip the
 *     canonical service) doesn't poison every later send.
 *
 * Regression context (2026-07-12, real data): two iMessage sends into an
 * SMS-only thread failed with error 22, created an iMessage chat leg, the
 * merged conversation started reporting "iMessage", and compose kept
 * retrying iMessage forever.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";

const NANOS_PER_SECOND = 1_000_000_000;
const MAC_EPOCH_OFFSET = 978_307_200;
function toMacTimestamp(d: Date): number {
  return Math.floor((d.getTime() / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** SMS thread with a long healthy history + two recent FAILED iMessage sends. */
function makePoisonedThreadFixture(): { chatDb: string; slugsDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-send-failure-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const slugsDb = join(dir, "slugs.db");
  const phone = "+15550000077";

  const cd = new Database(chatDb);
  cd.exec(`
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
      style INTEGER, state INTEGER, account_id TEXT, properties BLOB,
      chat_identifier TEXT, service_name TEXT, room_name TEXT,
      account_login TEXT, is_archived INTEGER DEFAULT 0,
      last_addressed_handle TEXT, display_name TEXT, group_id TEXT,
      is_filtered INTEGER DEFAULT 0, successful_query INTEGER,
      last_read_message_timestamp INTEGER DEFAULT 0
    );
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL,
      country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT,
      person_centric_id TEXT, UNIQUE (id, service)
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE NOT NULL,
      text TEXT, handle_id INTEGER DEFAULT 0, attributedBody BLOB,
      type INTEGER DEFAULT 0, service TEXT, error INTEGER DEFAULT 0,
      date INTEGER, date_read INTEGER, date_delivered INTEGER,
      is_delivered INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
      is_read INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0, associated_message_guid TEXT,
      associated_message_type INTEGER DEFAULT 0, associated_message_emoji TEXT,
      balloon_bundle_id TEXT, payload_data BLOB, message_summary_info BLOB,
      reply_to_guid TEXT, thread_originator_guid TEXT, thread_originator_part TEXT,
      date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0,
      is_edited INTEGER DEFAULT 0
    );
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
    CREATE TABLE chat_message_join (
      chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT,
      total_bytes INTEGER, created_date INTEGER, is_sticker INTEGER DEFAULT 0, uti TEXT
    );
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);

  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'SMS')").run(phone);
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'iMessage')").run(phone);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'SMS', 45)",
  ).run(`SMS;-;${phone}`, phone);
  // The phantom leg minted by the failed iMessage attempts.
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (2, ?, ?, 'iMessage', 45)",
  ).run(`iMessage;-;${phone}`, phone);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
  cd.prepare("INSERT INTO chat_handle_join VALUES (2, 2)").run();

  const base = toMacTimestamp(new Date(Date.UTC(2026, 5, 1)));
  const insert = (
    rowid: number,
    text: string,
    isFromMe: number,
    service: string,
    error: number,
    secondsOffset: number,
    chatId: number,
  ) => {
    const date = base + secondsOffset * NANOS_PER_SECOND;
    cd.prepare(`
      INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, is_read,
        is_delivered, service, error, item_type)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)
    `).run(
      rowid,
      `g${rowid}`,
      text,
      isFromMe ? null : 1,
      date,
      isFromMe,
      error ? 0 : 1,
      service,
      error,
    );
    cd.prepare("INSERT INTO chat_message_join VALUES (?, ?, ?)").run(chatId, rowid, date);
  };

  // Healthy SMS history: received + successfully-sent.
  insert(1, "hey", 0, "SMS", 0, 0, 1);
  insert(2, "yo", 1, "SMS", 0, 10, 1);
  insert(3, "how are you", 0, "SMS", 0, 20, 1);
  // The two most recent messages: FAILED iMessage sends (error 22) on the
  // phantom leg — exactly the poisoned state from the incident.
  insert(4, "did you get this?", 1, "iMessage", 22, 30, 2);
  insert(5, "hello?", 1, "iMessage", 22, 40, 2);
  cd.close();

  return { chatDb, slugsDb };
}

describe("send-failure awareness", () => {
  it("maps chat.db error onto Message.sendError for from-me messages", async () => {
    const { chatDb, slugsDb } = makePoisonedThreadFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const msgs = await db.getMessagesForChat("+15550000077", 50);
      const failed = msgs.filter((m) => m.sendError !== undefined);
      expect(failed.map((m) => m.text).sort()).toEqual(["did you get this?", "hello?"]);
      for (const f of failed) expect(f.sendError).toBe(22);
      // Healthy messages carry no sendError.
      expect(msgs.find((m) => m.text === "yo")?.sendError).toBeUndefined();
      expect(msgs.find((m) => m.text === "hey")?.sendError).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("prefers the service with delivery evidence, ignoring failed sends", async () => {
    const { chatDb, slugsDb } = makePoisonedThreadFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      // The two NEWEST messages are failed iMessage attempts — a naive
      // "latest message's service" would say iMessage and fail again.
      expect(db.getPreferredSendService("+15550000077")).toBe("SMS");
    } finally {
      await db.close();
    }
  });

  it("returns null for unknown conversations", async () => {
    const { chatDb, slugsDb } = makePoisonedThreadFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      expect(db.getPreferredSendService("+19998887777")).toBeNull();
    } finally {
      await db.close();
    }
  });
});
