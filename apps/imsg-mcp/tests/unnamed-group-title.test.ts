/**
 * Unnamed group chats get a synthesized member-based title (swarm finding:
 * the sidebar/drawer showed raw `chat926244..` identifiers for every group
 * without a display_name). Core-side fix in IMessageDB so the TUI and MCP
 * list_conversations both inherit it.
 */
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

const ALICE = "+15550001111";
const BOB = "+15550002222";
const STRANGER = "+15550003333";
const UNNAMED_ID = "chat926208792874094370";
const NAMED_ID = "chat111222333444555666";

/**
 * chat.db with TWO group chats — one with a display_name, one without —
 * plus an Address Book resolving two of the three members.
 */
function makeGroupFixture(): { chatDb: string; contactDb: string; slugsDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-group-title-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const contactDb = join(dir, "AddressBook-v22.abcddb");
  const slugsDb = join(dir, "slugs.db");

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
  const insertRecord = ab.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME) VALUES (?, ?, ?)",
  );
  const insertPhone = ab.prepare(
    "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZFULLNUMBER, ZLABEL, ZOWNER) VALUES (?, ?, ?, ?)",
  );
  insertRecord.run(1, "Alice", "Anderson");
  insertPhone.run(1, ALICE, "_$!<Mobile>!$_", 1);
  insertRecord.run(2, "Bob", "Brown");
  insertPhone.run(2, BOB, "_$!<Mobile>!$_", 2);
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

  const insertHandle = cd.prepare(
    "INSERT INTO handle (ROWID, id, service) VALUES (?, ?, 'iMessage')",
  );
  insertHandle.run(1, ALICE);
  insertHandle.run(2, BOB);
  insertHandle.run(3, STRANGER);

  // Unnamed group (display_name NULL) + named group
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style, display_name) VALUES (1, ?, ?, 'iMessage', 43, NULL)",
  ).run(`iMessage;+;${UNNAMED_ID}`, UNNAMED_ID);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style, display_name) VALUES (2, ?, ?, 'iMessage', 43, 'Weekend Crew')",
  ).run(`iMessage;+;${NAMED_ID}`, NAMED_ID);
  for (const h of [1, 2, 3]) {
    cd.prepare("INSERT INTO chat_handle_join VALUES (1, ?)").run(h);
    cd.prepare("INSERT INTO chat_handle_join VALUES (2, ?)").run(h);
  }

  const t = (1735689600 - 978307200) * 1e9;
  cd.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, service) VALUES (1, 'g1', 'hello group', 1, ?, 'iMessage')",
  ).run(t);
  cd.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, service) VALUES (2, 'g2', 'hello named', 2, ?, 'iMessage')",
  ).run(t + 1e9);
  cd.prepare("INSERT INTO chat_message_join VALUES (1, 1, ?)").run(t);
  cd.prepare("INSERT INTO chat_message_join VALUES (2, 2, ?)").run(t + 1e9);
  cd.close();

  return { chatDb, contactDb, slugsDb };
}

describe("unnamed group titles", () => {
  it("listConversations synthesizes a member-based title for unnamed groups", async () => {
    const { chatDb, contactDb, slugsDb } = makeGroupFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      const conversations = await db.listConversations(50);
      const unnamed = conversations.find((c) => c.chatIdentifier === UNNAMED_ID);
      expect(unnamed).toBeDefined();
      // First names for resolved contacts, whole handle for the stranger.
      expect(unnamed?.displayName).toBe(`Alice, Bob, ${STRANGER}`);
    } finally {
      await db.close();
    }
  });

  it("a real display_name always wins over synthesis", async () => {
    const { chatDb, contactDb, slugsDb } = makeGroupFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      const conversations = await db.listConversations(50);
      const named = conversations.find((c) => c.chatIdentifier === NAMED_ID);
      expect(named?.displayName).toBe("Weekend Crew");
    } finally {
      await db.close();
    }
  });

  it("findChatByHandle synthesizes the same title", async () => {
    const { chatDb, contactDb, slugsDb } = makeGroupFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      const conv = await db.findChatByHandle(UNNAMED_ID);
      expect(conv?.displayName).toBe(`Alice, Bob, ${STRANGER}`);
    } finally {
      await db.close();
    }
  });
});
