import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * Build a minimal chat.db with TWO chats for the same contact (one keyed
 * by phone, one by email) plus an Address Book entry that links both
 * handles to the same person. Exercises the contact-based thread merging
 * which collapses these into a single visible conversation row.
 */
function makeSplitContactFixture(): { chatDb: string; contactDb: string; slugsDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-thread-merge-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const contactDb = join(dir, "AddressBook-v22.abcddb");
  const slugsDb = join(dir, "slugs.db");

  // Address Book — one contact with both phone and email
  const ab = new Database(contactDb);
  ab.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZMIDDLENAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT
    );
    CREATE TABLE ZABCDPHONENUMBER (
      Z_PK INTEGER PRIMARY KEY, ZFULLNUMBER TEXT, ZLABEL TEXT, ZOWNER INTEGER, Z22_OWNER INTEGER
    );
    CREATE TABLE ZABCDEMAILADDRESS (
      Z_PK INTEGER PRIMARY KEY, ZADDRESS TEXT, ZLABEL TEXT, ZOWNER INTEGER, Z22_OWNER INTEGER
    );
  `);
  const PHONE = "+15550000077";
  const EMAIL = "alex.example@example.com";
  ab.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME) VALUES (?, ?, ?, ?)",
  ).run(1, "Alex", "Example", null);
  ab.prepare(
    "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZFULLNUMBER, ZLABEL, ZOWNER) VALUES (?, ?, ?, ?)",
  ).run(1, PHONE, "_$!<Mobile>!$_", 1);
  ab.prepare(
    "INSERT INTO ZABCDEMAILADDRESS (Z_PK, ZADDRESS, ZLABEL, ZOWNER) VALUES (?, ?, ?, ?)",
  ).run(1, EMAIL, "_$!<Home>!$_", 1);
  ab.close();

  // chat.db — two separate chats with this contact (phone + email)
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
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
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
    CREATE TABLE chat_handle_join (
      chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id)
    );
    CREATE TABLE chat_message_join (
      chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0,
      PRIMARY KEY (chat_id, message_id)
    );
  `);

  // Two handles, two chats
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'iMessage')").run(PHONE);
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'iMessage')").run(EMAIL);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'iMessage', 45)",
  ).run(`iMessage;-;${PHONE}`, PHONE);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (2, ?, ?, 'iMessage', 45)",
  ).run(`iMessage;-;${EMAIL}`, EMAIL);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
  cd.prepare("INSERT INTO chat_handle_join VALUES (2, 2)").run();

  // Two messages — one in each chat
  // Mac timestamp (nanoseconds since 2001-01-01)
  const t = (1735689600 - 978307200) * 1e9; // anchor 2025-01-01
  cd.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, service) VALUES (1, 'm1', 'first via phone', 1, ?, 'iMessage')",
  ).run(t);
  cd.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, service) VALUES (2, 'm2', 'second via email', 2, ?, 'iMessage')",
  ).run(t + 1e9);
  cd.prepare("INSERT INTO chat_message_join VALUES (1, 1, ?)").run(t);
  cd.prepare("INSERT INTO chat_message_join VALUES (2, 2, ?)").run(t + 1e9);
  cd.close();

  return { chatDb, contactDb, slugsDb };
}

describe("contact-based thread merging", () => {
  it("merges phone-keyed and email-keyed chats from one contact into one row", async () => {
    const { chatDb, contactDb, slugsDb } = makeSplitContactFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);

    try {
      const conversations = await db.listConversations(200);
      const alexRows = conversations.filter((c) => c.displayName === "Alex Example");

      // Both chats should collapse into a single visible row
      expect(alexRows).toHaveLength(1);
      expect(alexRows[0]?.participants.length).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });
});
