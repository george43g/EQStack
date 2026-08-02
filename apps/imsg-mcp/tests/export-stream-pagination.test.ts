import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MAC_EPOCH_OFFSET, NANOS_PER_SECOND } from "../src/db-schema.js";
import { streamExport } from "../src/exportStream.js";
import { IMessageDB } from "../src/imessage-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function toMacTimestamp(date: Date): number {
  return Math.floor((date.getTime() / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
}

function makeSplitContactExportFixture(): {
  chatDb: string;
  contactDb: string;
  slugsDb: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "imsg-export-pagination-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const contactDb = join(dir, "AddressBook-v22.abcddb");
  const slugsDb = join(dir, "slugs.db");

  const phone = "+15550000088";
  const email = "export.alex@example.com";

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
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME) VALUES (?, ?, ?, ?)",
  ).run(1, "Alex", "Export", null);
  ab.prepare(
    "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZFULLNUMBER, ZLABEL, ZOWNER) VALUES (?, ?, ?, ?)",
  ).run(1, phone, "_$!<Mobile>!$_", 1);
  ab.prepare(
    "INSERT INTO ZABCDEMAILADDRESS (Z_PK, ZADDRESS, ZLABEL, ZOWNER) VALUES (?, ?, ?, ?)",
  ).run(1, email, "_$!<Home>!$_", 1);
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
    CREATE TABLE chat_handle_join (
      chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id)
    );
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
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'iMessage')").run(email);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'iMessage', 45)",
  ).run(`iMessage;-;${phone}`, phone);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (2, ?, ?, 'iMessage', 45)",
  ).run(`iMessage;-;${email}`, email);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
  cd.prepare("INSERT INTO chat_handle_join VALUES (2, 2)").run();

  const base = toMacTimestamp(new Date(Date.UTC(2025, 0, 1, 0, 0, 0)));
  const insertMessage = (
    rowid: number,
    guid: string,
    text: string,
    handleId: number | null,
    date: number,
    isFromMe: number,
    associatedMessageType = 0,
    associatedMessageGuid: string | null = null,
  ) => {
    cd.prepare(`
      INSERT INTO message (
        ROWID, guid, text, handle_id, date, is_from_me, is_read, is_delivered,
        service, item_type, associated_message_type, associated_message_guid,
        cache_has_attachments
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'iMessage', 0, ?, ?, 0)
    `).run(
      rowid,
      guid,
      text,
      handleId,
      date,
      isFromMe,
      associatedMessageType,
      associatedMessageGuid,
    );
  };
  const linkMessage = (chatId: number, messageId: number, messageDate: number) => {
    cd.prepare("INSERT INTO chat_message_join VALUES (?, ?, ?)").run(
      chatId,
      messageId,
      messageDate,
    );
  };

  insertMessage(1, "m1", "newest low rowid", null, base + 4 * NANOS_PER_SECOND, 1);
  insertMessage(100, "m100", "middle high rowid", 1, base + 3 * NANOS_PER_SECOND, 0);
  insertMessage(101, "m101", "second", null, base + NANOS_PER_SECOND, 1);
  insertMessage(102, "m102", "oldest high rowid", 2, base, 0);
  insertMessage(103, "m103", "duplicate-linked message", 2, base + 2 * NANOS_PER_SECOND, 0);
  insertMessage(
    104,
    "m104",
    "Liked “middle high rowid”",
    2,
    base + 2.5 * NANOS_PER_SECOND,
    0,
    2001,
    "p:0/m100",
  );

  linkMessage(1, 1, base + 4 * NANOS_PER_SECOND);
  linkMessage(1, 100, base + 3 * NANOS_PER_SECOND);
  linkMessage(1, 103, base + 2 * NANOS_PER_SECOND);
  linkMessage(1, 104, base + 2.5 * NANOS_PER_SECOND);
  linkMessage(2, 101, base + NANOS_PER_SECOND);
  linkMessage(2, 102, base);
  linkMessage(2, 103, base + 2 * NANOS_PER_SECOND);
  cd.close();

  return { chatDb, contactDb, slugsDb };
}

describe("streamExport pagination", () => {
  it("exports every chronological message when ROWID order and date order diverge", async () => {
    const { chatDb, contactDb, slugsDb } = makeSplitContactExportFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    const outputPath = join(tempDirs[tempDirs.length - 1], "export.ndjson");

    try {
      const result = await streamExport({
        db,
        chatIdentifier: "+15550000088",
        format: "ndjson",
        outputPath,
        since: null,
        until: null,
        pageSize: 2,
      });

      const rows = readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: number; reactions?: unknown[] });
      const ids = rows.map((row) => row.id);

      expect(result.count).toBe(5);
      expect(ids).toEqual([102, 101, 103, 100, 1]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(104);
      expect(rows.find((row) => row.id === 100)?.reactions).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it("keeps the first message of every markdown page (no header over-slice)", async () => {
    const { chatDb, contactDb, slugsDb } = makeSplitContactExportFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    const outputPath = join(tempDirs[tempDirs.length - 1], "export.md");

    try {
      const result = await streamExport({
        db,
        chatIdentifier: "+15550000088",
        format: "markdown",
        outputPath,
        since: null,
        until: null,
        pageSize: 2, // first-of-page = m102, m103, m1 — the ones a header over-slice would drop
      });

      const body = readFileSync(outputPath, "utf8");
      // Every chronological message must be present, in date order.
      const ordered = [
        "oldest high rowid", // m102
        "second", // m101
        "duplicate-linked message", // m103
        "middle high rowid", // m100
        "newest low rowid", // m1
      ];
      for (const text of ordered) {
        expect(body).toContain(text);
      }
      const positions = ordered.map((t) => body.indexOf(t));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(result.count).toBe(5);
    } finally {
      await db.close();
    }
  });
});

describe("getMessagesForChat beforeMessageId pagination", () => {
  it("reaches every message with no skips or duplicates when ROWID order ≠ date order", async () => {
    const { chatDb, contactDb, slugsDb } = makeSplitContactExportFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);

    try {
      // Walk older via beforeMessageId = the oldest id of the previous page,
      // exactly as the MCP get_messages handler does.
      const seen = new Set<number>();
      let dupes = 0;
      let before: number | undefined;
      for (let i = 0; i < 20; i++) {
        const msgs = await db.getMessagesForChat(
          "+15550000088",
          2,
          before != null ? { beforeMessageId: before } : {},
        );
        if (msgs.length === 0) break;
        for (const m of msgs) {
          if (seen.has(m.id)) dupes++;
          else seen.add(m.id);
        }
        const oldest = msgs[0].id; // getMessagesForChat returns date-ascending
        if (before === oldest) break; // no progress → done
        before = oldest;
      }

      // All 5 normal messages across both merged chats (reaction m104 excluded),
      // reached with zero duplicates. The old ROWID-only bound reached ~2 of 5.
      expect([...seen].sort((a, b) => a - b)).toEqual([1, 100, 101, 102, 103]);
      expect(dupes).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe("afterMessageId + gap-fill composite cursors", () => {
  // Fixture chronology (date ascending): m102(base) → m101(+1s) → m103(+2s)
  // → m100(+3s) → m1(+4s). ROWIDs deliberately diverge: 102, 101, 103, 100, 1.

  it("afterMessageId returns chronologically-later messages even with LOWER ROWIDs", async () => {
    const { chatDb, contactDb, slugsDb } = makeSplitContactExportFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      // Boundary m100 (+3s). The only later message is m1 (+4s) — ROWID 1,
      // far BELOW the boundary id. A ROWID-only bound returned nothing here.
      const after = await db.getMessagesForChat("+15550000088", 50, { afterMessageId: 100 });
      expect(after.map((m) => m.id)).toEqual([1]);
    } finally {
      await db.close();
    }
  });

  it("getMessagesAfter delivers an incoming reply whose ROWID precedes the boundary (wait_for_reply P0)", async () => {
    const { chatDb, contactDb, slugsDb } = makeSplitContactExportFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      // Boundary m103 (+2s). The incoming reply m100 arrived later (+3s) but
      // was stored with ROWID 100 < 103 (iCloud-sync reorder). The old
      // ROWID-only path returned [] — wait_for_reply would poll forever.
      const replies = await db.getMessagesAfter("+15550000088", 103);
      expect(replies.map((m) => m.id)).toContain(100);
      // ...and never resurfaces chronologically OLDER messages as "new".
      expect(replies.map((m) => m.id)).not.toContain(101);
      expect(replies.map((m) => m.id)).not.toContain(102);
    } finally {
      await db.close();
    }
  });

  it("gap-fill (after+before) returns the chronological interior, not the ROWID interval", async () => {
    const { chatDb, contactDb, slugsDb } = makeSplitContactExportFixture();
    const db = new IMessageDB(chatDb, [contactDb], slugsDb);
    try {
      // Chronological gap between m102 (base) and m100 (+3s) contains m101
      // (+1s, ROWID 101) and m103 (+2s, ROWID 103) — BOTH outside the ROWID
      // interval (102, 100), which is empty. The old bound returned [].
      const gap = await db.getMessagesForChat("+15550000088", 50, {
        afterMessageId: 102,
        beforeMessageId: 100,
      });
      expect(gap.map((m) => m.id)).toEqual([101, 103]);
    } finally {
      await db.close();
    }
  });
});
