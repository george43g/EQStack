/**
 * getChatStats must count each message ONCE, even when it is joined to more
 * than one leg of a merged identity. Messages.app frequently links a single
 * message row into both the iMessage and SMS chat rows for a contact; the
 * original COUNT(*) over the chat_message_join counted it per-leg and inflated
 * the humans-file message totals (observed: +727 on a real contact).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";

const NANOS = 1_000_000_000;
const MAC_EPOCH = 978_307_200;
const toMac = (d: Date) => Math.floor((d.getTime() / 1000 - MAC_EPOCH) * NANOS);

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeFixture(): { chatDb: string; slugsDb: string; phone: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-chatstats-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const slugsDb = join(dir, "slugs.db");
  const phone = "+15550000055";
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
      date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0, is_edited INTEGER DEFAULT 0
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
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'iMessage')").run(phone);
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'SMS')").run(phone);
  // Two legs, same identifier (iMessage + SMS) — merge into one identity.
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'iMessage', 45)",
  ).run(`iMessage;-;${phone}`, phone);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (2, ?, ?, 'SMS', 45)",
  ).run(`SMS;-;${phone}`, phone);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
  cd.prepare("INSERT INTO chat_handle_join VALUES (2, 2)").run();

  const base = toMac(new Date(Date.UTC(2026, 0, 1)));
  const addMsg = (rowid: number, secs: number, legs: number[]) => {
    const date = base + secs * NANOS;
    cd.prepare(`
      INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, is_read,
        is_delivered, service, item_type, associated_message_type)
      VALUES (?, ?, ?, 1, ?, 0, 1, 1, 'iMessage', 0, 0)
    `).run(rowid, `g${rowid}`, `msg ${rowid}`, date);
    for (const leg of legs) {
      cd.prepare("INSERT INTO chat_message_join VALUES (?, ?, ?)").run(leg, rowid, date);
    }
  };
  // 3 messages only on the iMessage leg, 2 only on SMS, and 1 joined to BOTH.
  addMsg(1, 0, [1]);
  addMsg(2, 10, [1]);
  addMsg(3, 20, [1]);
  addMsg(4, 30, [2]);
  addMsg(5, 40, [2]);
  addMsg(6, 50, [1, 2]); // the double-joined message
  cd.close();
  return { chatDb, slugsDb, phone };
}

describe("getChatStats", () => {
  it("counts a message joined to multiple legs exactly once", async () => {
    const { chatDb, slugsDb, phone } = makeFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const stats = db.getChatStats(phone);
      // 6 distinct messages, NOT 7 (the double-joined one must not count twice).
      expect(stats.count).toBe(6);
      expect(stats.first).not.toBeNull();
      expect(stats.last).not.toBeNull();
      expect(stats.last!.getTime()).toBeGreaterThan(stats.first!.getTime());
    } finally {
      await db.close();
    }
  });

  it("returns zero for an unknown conversation", async () => {
    const { chatDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      expect(db.getChatStats("+19998887777")).toEqual({ count: 0, first: null, last: null });
    } finally {
      await db.close();
    }
  });
});
