/**
 * `IMessageDB.resolveConversation` — fuses contacts + thread names + message
 * content into one ranked lookup so an agent can turn "check Selena's messages"
 * into a concrete thread in a single call.
 *
 * Assertions avoid the exact `~imsg~` slug format (cold fixtures haven't synced
 * the slug store), matching on name / matchType / chatIdentifier instead.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

const SELENA_PHONE = "+15550000077";
const FRIEND_PHONE = "+15550000088";

function makeFixture(): { chatDb: string; contactDb: string; slugsDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-resolve-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const contactDb = join(dir, "AddressBook-v22.abcddb");
  const slugsDb = join(dir, "slugs.db");

  // Address Book — one named contact so the contact-search signal fires.
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
  ab.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME) VALUES (1, 'Selena', 'Rivera')",
  ).run();
  ab.prepare(
    "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZFULLNUMBER, ZLABEL, ZOWNER) VALUES (1, ?, '_$!<Mobile>!$_', 1)",
  ).run(SELENA_PHONE);
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
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
    CREATE TABLE chat_message_join (
      chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0,
      PRIMARY KEY (chat_id, message_id)
    );
  `);

  // Chat 1 — 1:1 with the contact Selena (name comes from the Address Book).
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'iMessage')").run(SELENA_PHONE);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'iMessage', 45)",
  ).run(`iMessage;-;${SELENA_PHONE}`, SELENA_PHONE);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();

  // Chat 2 — a NAMED group "Weekend Crew" whose only distinctive body word is
  // "pizza" (so it can only be found by message-content matching).
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'iMessage')").run(FRIEND_PHONE);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style, room_name, display_name) VALUES (2, 'iMessage;+;chat-weekend', 'chat-weekend', 'iMessage', 43, 'chat-weekend', 'Weekend Crew')",
  ).run();
  cd.prepare("INSERT INTO chat_handle_join VALUES (2, 2)").run();

  const base = (1735689600 - 978307200) * 1e9; // anchor 2025-01-01
  cd.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, service) VALUES (1, 'm1', 'morning!', 1, ?, 'iMessage')",
  ).run(base);
  cd.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, service) VALUES (2, 'm2', 'who wants pizza tonight', 2, ?, 'iMessage')",
  ).run(base + 1e9);
  cd.prepare("INSERT INTO chat_message_join VALUES (1, 1, ?)").run(base);
  cd.prepare("INSERT INTO chat_message_join VALUES (2, 2, ?)").run(base + 1e9);
  cd.close();

  return { chatDb, contactDb, slugsDb };
}

describe("resolveConversation", () => {
  it("resolves a contact name to its thread (contact/thread signal)", async () => {
    const { chatDb, contactDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      const matches = await db.resolveConversation("selena");
      expect(matches.length).toBeGreaterThan(0);
      const top = matches[0];
      expect(top.name).toBe("Selena Rivera");
      expect(["contact", "thread"]).toContain(top.matchType);
      expect(top.chatIdentifier).toBe(SELENA_PHONE);
      expect(top.score).toBeGreaterThanOrEqual(0.9);
    } finally {
      await db.close();
    }
  });

  it("resolves a group by its display name", async () => {
    const { chatDb, contactDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      const matches = await db.resolveConversation("weekend");
      const crew = matches.find((m) => m.name === "Weekend Crew");
      expect(crew, "group not resolved by name").toBeDefined();
      expect(crew?.matchType).toBe("thread");
    } finally {
      await db.close();
    }
  });

  it("falls back to message content when no name matches", async () => {
    const { chatDb, contactDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      const matches = await db.resolveConversation("pizza");
      const hit = matches.find((m) => m.chatIdentifier === "chat-weekend");
      expect(hit, "message-content match missing").toBeDefined();
      expect(hit?.matchType).toBe("message");
    } finally {
      await db.close();
    }
  });

  it("returns nothing for an empty or whitespace query", async () => {
    const { chatDb, contactDb, slugsDb } = makeFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      expect(await db.resolveConversation("")).toEqual([]);
      expect(await db.resolveConversation("   ")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
