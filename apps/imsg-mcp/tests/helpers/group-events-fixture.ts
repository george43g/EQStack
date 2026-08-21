/**
 * Shared synthetic chat.db fixture with group-system events (item_type 1/2/3):
 * one group ("Crew"), one normal message, then add / rename / remove / left.
 * Used by the DB-layer test (conversation-events) and the MCP tool test
 * (get_conversation_events). Row shape verified on the real DB 2026-08-16.
 *
 * Callers must invoke `cleanupGroupEventFixtures()` in afterEach.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export const ALICE = "+15550001111";
export const BOB = "+15550002222";
export const GROUP_ID = "chat555666777888999000";
export const T0 = (1735689600 - 978307200) * 1e9; // 2025-01-01 in Mac-epoch ns

const tempDirs: string[] = [];

export function cleanupGroupEventFixtures(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
}

export function makeGroupEventsFixture(): { chatDb: string; contactDb: string; slugsDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-group-events-"));
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
  ab.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME) VALUES (1, 'Alice', 'A')",
  ).run();
  ab.prepare(
    "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZFULLNUMBER, ZLABEL, ZOWNER) VALUES (1, ?, '_$!<Mobile>!$_', 1)",
  ).run(ALICE);
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
      item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0,
      group_title TEXT, group_action_type INTEGER DEFAULT 0,
      associated_message_guid TEXT,
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

  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'iMessage')").run(ALICE);
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'iMessage')").run(BOB);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style, display_name) VALUES (1, ?, ?, 'iMessage', 43, 'Crew')",
  ).run(`iMessage;+;${GROUP_ID}`, GROUP_ID);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 2)").run();

  const insertMsg = cd.prepare(
    `INSERT INTO message (ROWID, guid, handle_id, date, service, is_from_me,
       item_type, other_handle, group_title, group_action_type)
     VALUES (?, ?, ?, ?, 'iMessage', ?, ?, ?, ?, ?)`,
  );
  const link = cd.prepare("INSERT INTO chat_message_join VALUES (1, ?, ?)");
  // 1: a normal message (must NOT surface as an event)
  cd.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, service) VALUES (1, 'n1', 'hello', 1, ?, 'iMessage')",
  ).run(T0);
  link.run(1, T0);
  // 2: Alice added Bob
  insertMsg.run(2, "e-add", 1, T0 + 1e9, 0, 1, 2, null, 0);
  link.run(2, T0 + 1e9);
  // 3: the user renamed the group
  insertMsg.run(3, "e-rename", 0, T0 + 2e9, 1, 2, 0, "Weekend Crew", 0);
  link.run(3, T0 + 2e9);
  // 4: Alice removed Bob
  insertMsg.run(4, "e-remove", 1, T0 + 3e9, 0, 1, 2, null, 1);
  link.run(4, T0 + 3e9);
  // 5: Alice left
  insertMsg.run(5, "e-left", 1, T0 + 4e9, 0, 3, 0, null, 0);
  link.run(5, T0 + 4e9);
  cd.close();

  return { chatDb, contactDb, slugsDb };
}
