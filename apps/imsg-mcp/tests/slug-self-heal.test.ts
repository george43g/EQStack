/**
 * Contact-edit self-healing: when Address Book edits change what slug a chat
 * SHOULD have (a number moved to a different contact, two contacts swapped
 * names, a card renamed), the persisted slug store holds stale rows. The
 * background sync must detect the mismatch (stored guid→slug ≠ freshly
 * computed slug), remap the guid, and prune the orphaned slug row — without
 * crashing and without requiring the user to delete slugs.db.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";
import { SlugStore } from "../src/slug-store.js";

const NANOS_PER_SECOND = 1_000_000_000;
const MAC_EPOCH_OFFSET = 978_307_200;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeFixture(): { chatDb: string; slugsDb: string; guid: string; phone: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-slug-heal-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const slugsDb = join(dir, "slugs.db");
  const phone = "+15550004242";
  const guid = `iMessage;-;${phone}`;

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
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'iMessage', 45)",
  ).run(guid, phone);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
  const date = Math.floor((Date.UTC(2026, 5, 1) / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
  cd.prepare(`
    INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, is_read,
      is_delivered, service, error, item_type)
    VALUES (1, 'g1', 'hi', 1, ?, 0, 1, 1, 'iMessage', 0, 0)
  `).run(date);
  cd.prepare("INSERT INTO chat_message_join VALUES (1, 1, ?)").run(date);
  cd.close();

  return { chatDb, slugsDb, guid, phone };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("slug store self-healing after contact edits", () => {
  it("remaps a guid whose expected slug changed and prunes the stale slug", async () => {
    const { chatDb, slugsDb, guid, phone } = makeFixture();

    // Simulate the pre-edit world: the slug minted when this number belonged
    // to a differently-named contact (or before two contacts swapped names).
    const staleSlug = "old-owner~imsg~dead";
    const seed = new SlugStore(slugsDb);
    seed.upsert({
      slug: staleSlug,
      chatGuid: guid,
      chatIdentifier: phone,
      displayName: "Old Owner",
      service: "iMessage",
      isGroup: false,
      participants: phone,
      updatedAt: Date.now() - 1000,
    });
    seed.close();

    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      // Before sync completes, the stale slug still resolves (cached load).
      expect(db.getSlugRecord(staleSlug)).not.toBeNull();

      db.scheduleBackgroundRefresh();

      // The check-and-heal store: stale slug pruned, fresh slug live.
      const store = () => new SlugStore(slugsDb);
      await waitFor(() => {
        const s = store();
        try {
          return s.lookupBySlug(staleSlug) === null && s.lookupByGuid(guid) !== null;
        } finally {
          s.close();
        }
      });

      const healed = store();
      let healedSlug: string;
      try {
        const record = healed.lookupByGuid(guid);
        expect(record).not.toBeNull();
        expect(record!.slug).not.toBe(staleSlug);
        expect(record!.chatIdentifier).toBe(phone);
        // Exactly one identity row remains — no duplicate/orphan rows.
        expect(healed.all()).toHaveLength(1);
        healedSlug = record!.slug;
      } finally {
        healed.close();
      }

      // The healed slug resolves through the live DB instance too.
      const conv = await db.findChatByHandle(phone);
      expect(conv?.threadSlug).toBe(healedSlug);
    } finally {
      await db.close();
    }
  });

  it("a wiped slugs.db rebuilds from scratch (derived data, never load-bearing)", async () => {
    const { chatDb, slugsDb, guid, phone } = makeFixture();
    // No pre-seeded store at all — equivalent to the user deleting slugs.db.
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      db.scheduleBackgroundRefresh();
      const store = () => new SlugStore(slugsDb);
      await waitFor(() => {
        const s = store();
        try {
          return s.lookupByGuid(guid) !== null;
        } finally {
          s.close();
        }
      });
      const conv = await db.findChatByHandle(phone);
      expect(conv?.threadSlug).toBeTruthy();
    } finally {
      await db.close();
    }
  });
});
