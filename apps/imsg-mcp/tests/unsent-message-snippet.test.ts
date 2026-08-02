/**
 * Conversation-list preview for an UNSENT last message.
 *
 * Regression (real data): a message George sent and then unsent has text=NULL
 * and an EMPTY attributedBody (the retract lives in message_summary_info).
 * The snippet resolver ran out of text sources and fell through to a raw-byte
 * scan of the chat `properties` bplist, which surfaced a decoded fragment
 * ("#DWm" → "DWm") in the sidebar. The fix: when the last message has no text,
 * fall back to the most recent message that DOES — regardless of sender.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";

const NANOS_PER_SECOND = 1_000_000_000;
const MAC_EPOCH_OFFSET = 978_307_200;
const toMac = (d: Date) => Math.floor((d.getTime() / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeFixture(): { chatDb: string; slugsDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-unsent-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const slugsDb = join(dir, "slugs.db");
  const phone = "+15550000099";

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
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'iMessage')").run(phone);
  // properties blob carrying a null-padded "#DWm" run and NO structured
  // chatSummary — the exact shape that used to leak into the preview.
  const junkProps = Buffer.concat([
    Buffer.from("bplist00props", "utf8"),
    Buffer.from([0, 0x23, 0, 0x44, 0, 0x57, 0, 0x6d]),
    Buffer.from("tail", "utf8"),
  ]);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style, properties) VALUES (1, ?, ?, 'iMessage', 45, ?)",
  ).run(`iMessage;-;${phone}`, phone, junkProps);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();

  const base = toMac(new Date(Date.UTC(2026, 5, 1)));
  const insert = (rowid: number, text: string | null, fromMe: number, secs: number) => {
    const date = base + secs * NANOS_PER_SECOND;
    cd.prepare(`
      INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, is_read,
        is_delivered, service, item_type, associated_message_type)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'iMessage', 0, 0)
    `).run(rowid, `g${rowid}`, text, fromMe ? null : 1, date, fromMe);
    cd.prepare("INSERT INTO chat_message_join VALUES (1, ?, ?)").run(rowid, date);
  };
  insert(1, "hey how are you", 0, 0);
  insert(2, "all good thanks", 1, 10);
  insert(3, "Just some girls asking me what happened", 0, 20);
  // The unsent last message: text NULL, empty attributedBody, retract MSI.
  const date = base + 30 * NANOS_PER_SECOND;
  cd.prepare(`
    INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, date, is_from_me,
      is_read, is_delivered, service, item_type, associated_message_type, message_summary_info)
    VALUES (4, 'g4', NULL, ?, NULL, ?, 1, 1, 1, 'iMessage', 0, 0, ?)
  `).run(Buffer.alloc(0), date, Buffer.from("bplist00retract", "utf8"));
  cd.prepare("INSERT INTO chat_message_join VALUES (1, 4, ?)").run(date);
  cd.close();
  return { chatDb, slugsDb };
}

describe("unsent last-message snippet", () => {
  it("shows the previous real message, never chat-properties noise", async () => {
    const { chatDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const convs = await db.listConversations(10);
      expect(convs.length).toBe(1);
      const snippet = convs[0].lastMessageSnippet;
      expect(snippet).toBe("Just some girls asking me what happened");
      // Crucially, NOT the leaked "DWm".
      expect(snippet).not.toContain("DWm");
    } finally {
      await db.close();
    }
  });
});
