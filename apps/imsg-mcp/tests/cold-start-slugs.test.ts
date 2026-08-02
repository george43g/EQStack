/**
 * Cold-start slug display.
 *
 * Regression: single-shot CLI commands (`imsg list`) exit before the background
 * slug sync persists, so `listConversations` used to fall back to the raw
 * chat_identifier (a phone number) instead of a `name~service~hash` slug — the
 * agent/MCP path was unaffected because the server is long-lived. The fix
 * computes the canonical slug synchronously for the returned page. This test
 * constructs an IMessageDB against a FRESH (empty) slug store — exactly the cold
 * state — and asserts the returned conversations carry real slugs, with the
 * canonical service segment (iMessage vs SMS) resolved per identity.
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
const SLUG_RE = /~(imsg|sms)~[0-9a-f]+$/;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeFixture(): { chatDb: string; slugsDb: string; imsgPhone: string; smsPhone: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-cold-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  // Intentionally a path that does NOT exist yet — the cold state.
  const slugsDb = join(dir, "slugs.db");
  const imsgPhone = "+15551230001";
  const smsPhone = "+15551230002";

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

  // Two 1:1 chats on different services.
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'iMessage')").run(imsgPhone);
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'SMS')").run(smsPhone);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'iMessage', 45)",
  ).run(`iMessage;-;${imsgPhone}`, imsgPhone);
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (2, ?, ?, 'SMS', 45)",
  ).run(`SMS;-;${smsPhone}`, smsPhone);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
  cd.prepare("INSERT INTO chat_handle_join VALUES (2, 2)").run();

  const base = toMac(new Date(Date.UTC(2026, 5, 1)));
  cd.prepare(`
    INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, is_read, is_delivered, service)
    VALUES (1, 'g-imsg', 'hi over imessage', 1, ?, 0, 1, 1, 'iMessage')
  `).run(base + 10 * NANOS_PER_SECOND);
  cd.prepare("INSERT INTO chat_message_join VALUES (1, 1, ?)").run(base + 10 * NANOS_PER_SECOND);
  cd.prepare(`
    INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, is_read, is_delivered, service)
    VALUES (2, 'g-sms', 'hi over sms', 2, ?, 0, 1, 1, 'SMS')
  `).run(base + 20 * NANOS_PER_SECOND);
  cd.prepare("INSERT INTO chat_message_join VALUES (2, 2, ?)").run(base + 20 * NANOS_PER_SECOND);

  cd.close();
  return { chatDb, slugsDb, imsgPhone, smsPhone };
}

describe("cold-start slug display", () => {
  it("returns real ~service~hash slugs from a fresh (empty) slug store, not raw identifiers", async () => {
    const { chatDb, slugsDb, imsgPhone, smsPhone } = makeFixture();
    // No background sync is scheduled by the constructor, so this exercises the
    // synchronous cold path directly.
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const convos = await db.listConversations(20);
      expect(convos).toHaveLength(2);

      for (const c of convos) {
        // The headline bug: threadSlug used to equal the raw phone number.
        expect(c.threadSlug).not.toBe(c.chatIdentifier);
        expect(c.threadSlug, `slug for ${c.chatIdentifier}`).toMatch(SLUG_RE);
      }

      const imsg = convos.find((c) => c.chatIdentifier === imsgPhone);
      const sms = convos.find((c) => c.chatIdentifier === smsPhone);
      expect(imsg?.threadSlug).toContain("~imsg~");
      expect(sms?.threadSlug).toContain("~sms~");
    } finally {
      await db.close();
    }
  });

  it("persists the computed slugs so a subsequent cold run resolves them", async () => {
    const { chatDb, slugsDb } = makeFixture();
    const first = new IMessageDB(chatDb, undefined, slugsDb);
    let slugs: string[];
    try {
      slugs = (await first.listConversations(20))
        .map((c) => c.threadSlug)
        .filter(Boolean) as string[];
      expect(slugs).toHaveLength(2);
    } finally {
      await first.close();
    }
    // Re-open against the now-warmed slug store: the same slugs resolve back.
    const second = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      for (const slug of slugs) {
        expect(second.findChatBySlug(slug), `resolve ${slug}`).not.toBeNull();
      }
    } finally {
      await second.close();
    }
  });
});
