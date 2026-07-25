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

const MAC_EPOCH = 978307200; // 2001-01-01 in Unix seconds
function macNs(unixSeconds: number): number {
  return (unixSeconds - MAC_EPOCH) * 1e9;
}

type ChatSpec = {
  rowid: number;
  identifier: string;
  service: string;
  text: string;
  unixSec: number;
};

/**
 * Build a chat.db with several INDEPENDENT conversations (no shared contact, so
 * they never merge into one identity). One of them uses a short numeric
 * identifier that is a SUFFIX substring of another's full phone number — the
 * exact shape that made the old bidirectional `includes` fold the wrong
 * identity into `resolveChatsForConversation`.
 */
function makeChatsFixture(specs: ChatSpec[]): {
  chatDb: string;
  contactDb: string;
  slugsDb: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "imsg-overmatch-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const contactDb = join(dir, "AddressBook-v22.abcddb");
  const slugsDb = join(dir, "slugs.db");

  // Empty Address Book (tables present, no rows) → handle-based identities,
  // no cross-chat contact merge.
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
  ab.close();

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

  for (const s of specs) {
    const d = macNs(s.unixSec);
    cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, ?)").run(
      s.rowid,
      s.identifier,
      s.service,
    );
    cd.prepare(
      "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (?, ?, ?, ?, 45)",
    ).run(s.rowid, `${s.service};-;${s.identifier}`, s.identifier, s.service);
    cd.prepare("INSERT INTO chat_handle_join VALUES (?, ?)").run(s.rowid, s.rowid);
    cd.prepare(
      "INSERT INTO message (ROWID, guid, text, handle_id, date, service, is_from_me) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ).run(s.rowid, `m${s.rowid}`, s.text, s.rowid, d, s.service);
    cd.prepare("INSERT INTO chat_message_join VALUES (?, ?, ?)").run(s.rowid, s.rowid, d);
  }
  cd.close();

  return { chatDb, contactDb, slugsDb };
}

describe("resolveChatsForConversation over-match tightening", () => {
  it("does not fold a short shortcode-style identifier into a full phone query", async () => {
    // Chat 1: a full phone number. Chat 2: a 6-digit shortcode ("234567") that
    // is a SUFFIX of chat 1's digits — and it is NEWER, so under the old
    // recency-based representative pick, querying the full number would have
    // returned the shortcode's messages.
    const { chatDb, contactDb, slugsDb } = makeChatsFixture([
      {
        rowid: 1,
        identifier: "+15551234567",
        service: "iMessage",
        text: "full-number-msg",
        unixSec: 1735689600,
      },
      {
        rowid: 2,
        identifier: "234567",
        service: "SMS",
        text: "shortcode-msg",
        unixSec: 1735689660,
      },
    ]);
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      const msgs = await db.getMessagesForChat("+15551234567", 20);
      const texts = msgs.map((m) => m.text);
      expect(texts).toContain("full-number-msg");
      expect(texts).not.toContain("shortcode-msg");

      // …and the shortcode is still reachable by its own exact identifier.
      const sc = await db.getMessagesForChat("234567", 20);
      expect(sc.map((m) => m.text)).toContain("shortcode-msg");
    } finally {
      await db.close();
    }
  });

  it("still matches a phone number missing its country code (suffix fuzzy)", async () => {
    const { chatDb, contactDb, slugsDb } = makeChatsFixture([
      {
        rowid: 1,
        identifier: "+15551234567",
        service: "iMessage",
        text: "cc-msg",
        unixSec: 1735689600,
      },
    ]);
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      // Query without the "+1" — legitimate country-code tolerance.
      const msgs = await db.getMessagesForChat("5551234567", 20);
      expect(msgs.map((m) => m.text)).toContain("cc-msg");
      // And a formatted variant with punctuation.
      const punct = await db.getMessagesForChat("(555) 123-4567", 20);
      expect(punct.map((m) => m.text)).toContain("cc-msg");
    } finally {
      await db.close();
    }
  });

  it("does not match a near-identical but different email", async () => {
    const { chatDb, contactDb, slugsDb } = makeChatsFixture([
      {
        rowid: 1,
        identifier: "alice@example.co",
        service: "iMessage",
        text: "email-msg",
        unixSec: 1735689600,
      },
    ]);
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      // ".com" query must NOT collide with the ".co" chat.
      const wrong = await db.getMessagesForChat("alice@example.com", 20);
      expect(wrong).toHaveLength(0);
      // Exact email still resolves.
      const right = await db.getMessagesForChat("alice@example.co", 20);
      expect(right.map((m) => m.text)).toContain("email-msg");
    } finally {
      await db.close();
    }
  });
});
