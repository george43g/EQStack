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
 * Build a chat.db where ONE contact has both an iMessage leg (older message)
 * and an SMS leg (NEWER message). The recency-based merge cascade picks the
 * newer SMS leg as the representative row — but the thread is fundamentally
 * iMessage (an iMessage leg exists, and the ~imsg~ slug reflects that).
 *
 * Regression fixture for the "sidebar badge shows SMS on an iMessage thread"
 * bug: the badge must be identity-canonical (prefer iMessage), matching the
 * slug + the slug-store send route, not whichever leg won the merge.
 */
function makeMixedServiceFixture(): { chatDb: string; contactDb: string; slugsDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-service-badge-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const contactDb = join(dir, "AddressBook-v22.abcddb");
  const slugsDb = join(dir, "slugs.db");
  const PHONE = "+15550000088";

  // Address Book — one contact owning the phone number, so both legs resolve
  // to the same identity (contact-based merge key).
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
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME) VALUES (1, 'Dana', 'Fixture')",
  ).run();
  ab.prepare(
    "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZFULLNUMBER, ZLABEL, ZOWNER) VALUES (1, ?, '_$!<Mobile>!$_', 1)",
  ).run(PHONE);
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

  // iMessage leg (handle 1) + SMS leg (handle 2), same phone number.
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'iMessage')").run(PHONE);
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'SMS')").run(PHONE);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'iMessage', 45)",
  ).run(`iMessage;-;${PHONE}`, PHONE);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (2, ?, ?, 'SMS', 45)",
  ).run(`SMS;-;${PHONE}`, PHONE);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
  cd.prepare("INSERT INTO chat_handle_join VALUES (2, 2)").run();

  // OLDER message on the iMessage leg, NEWER on the SMS leg → the SMS leg wins
  // the recency-based merge cascade, which used to flip the badge to "SMS".
  const t = (1735689600 - 978307200) * 1e9; // 2025-01-01 in Mac epoch ns
  cd.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, service) VALUES (1, 'im1', 'imsg', 1, ?, 'iMessage')",
  ).run(t);
  cd.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, service) VALUES (2, 'sms1', 'sms', 2, ?, 'SMS')",
  ).run(t + 60e9);
  cd.prepare("INSERT INTO chat_message_join VALUES (1, 1, ?)").run(t);
  cd.prepare("INSERT INTO chat_message_join VALUES (2, 2, ?)").run(t + 60e9);
  cd.close();

  return { chatDb, contactDb, slugsDb };
}

describe("conversation service badge (identity-canonical)", () => {
  it("stays iMessage when an iMessage leg exists even though the newest leg is SMS", async () => {
    const { chatDb, contactDb, slugsDb } = makeMixedServiceFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);

    try {
      const conversations = await db.listConversations(200);
      const row = conversations.find((c) => c.displayName === "Dana Fixture");
      expect(row).toBeDefined();
      // Badge is identity-canonical (prefer iMessage) — not the merge-winner leg.
      expect(row?.serviceType).toBe("iMessage");
      // …and it agrees with the slug's service segment (~imsg~), which is the
      // whole point: badge, slug, and send route must never disagree.
      expect(row?.threadSlug).toContain("~imsg~");
    } finally {
      await db.close();
    }
  });

  it("resolves the same iMessage badge via findChatByHandle", async () => {
    const { chatDb, contactDb, slugsDb } = makeMixedServiceFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);

    try {
      const conv = await db.findChatByHandle("+15550000088");
      expect(conv).not.toBeNull();
      expect(conv?.serviceType).toBe("iMessage");
    } finally {
      await db.close();
    }
  });
});
