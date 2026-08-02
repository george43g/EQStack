import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAC_EPOCH_OFFSET, NANOS_PER_SECOND } from "../src/db-schema.js";
import { IMessageDB } from "../src/imessage-db.js";
import { IMessageMCPServer } from "../src/index.js";

/**
 * Pagination contract for list_conversations: the per-call cap is a page size,
 * and `offset` + `nextOffset` must let a caller tile the full list with no
 * overlaps or gaps. Regression guard for the old behaviour where the tool
 * returned `hasMore: true` with `nextOffset: null` — a dead end that stranded
 * every conversation past the cap.
 */
describe("list_conversations pagination", () => {
  let server: any;

  beforeAll(() => {
    process.env.IMSG_DEV = "1";
    server = new IMessageMCPServer();
  });

  afterAll(async () => {
    delete process.env.IMSG_DEV;
    await server.db?.close();
  });

  const slugsOf = (res: any): string[] =>
    (res?.structuredContent?.conversations ?? []).map((c: any) => c.threadSlug);

  it("tiles pages with offset/nextOffset — no overlap, no gaps", async () => {
    const baseline = await server.handleListConversations({ limit: 6, offset: 0 });
    const baseSlugs = slugsOf(baseline);
    // Needs a fixture with enough conversations to page; skip otherwise.
    if (baseSlugs.length < 6) return;

    const page0 = await server.handleListConversations({ limit: 2, offset: 0 });
    const page1 = await server.handleListConversations({ limit: 2, offset: 2 });
    const page2 = await server.handleListConversations({ limit: 2, offset: 4 });

    // Each early page reports the next window and is non-empty.
    expect(page0.structuredContent.hasMore).toBe(true);
    expect(page0.structuredContent.nextOffset).toBe(2);
    expect(page1.structuredContent.nextOffset).toBe(4);

    const tiled = [...slugsOf(page0), ...slugsOf(page1), ...slugsOf(page2)];
    // Three 2-wide pages reconstruct the first 6 of the single-call baseline...
    expect(tiled).toEqual(baseSlugs);
    // ...with no conversation appearing on two pages.
    expect(new Set(tiled).size).toBe(tiled.length);
  });

  it("returns an empty, terminal page when offset runs past the end", async () => {
    const res = await server.handleListConversations({ limit: 5, offset: 1_000_000 });
    expect(res.structuredContent.count).toBe(0);
    expect(res.structuredContent.hasMore).toBe(false);
    expect(res.structuredContent.nextOffset).toBeNull();
  });
});

/**
 * Heavy-merge starvation: when many chat rows collapse into few conversations,
 * a fixed over-fetch factor (the old `limit * 3` candidate slice) produced a
 * deduped list SHORTER than the requested window and silently truncated the
 * page. Enrichment must keep going until enough deduped rows exist.
 */
describe("listConversations heavy-merge dedup", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
  });

  it("returns the full requested page even when the newest chats all merge into one conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imsg-heavy-merge-"));
    tempDirs.push(dir);
    const chatDb = join(dir, "chat.db");
    const slugsDb = join(dir, "slugs.db");

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

    const base = Math.floor((Date.UTC(2025, 5, 1) / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
    let msgId = 0;
    const addChatWithMessage = (guid: string, identifier: string, offsetSec: number) => {
      const info = cd
        .prepare(
          "INSERT INTO chat (guid, chat_identifier, service_name, style) VALUES (?, ?, 'iMessage', 45)",
        )
        .run(guid, identifier);
      const date = base + offsetSec * NANOS_PER_SECOND;
      msgId += 1;
      cd.prepare(
        "INSERT INTO message (ROWID, guid, text, handle_id, date, is_read, is_delivered, service) VALUES (?, ?, ?, 0, ?, 1, 1, 'iMessage')",
      ).run(msgId, `m${msgId}`, `msg ${msgId}`, date);
      cd.prepare("INSERT INTO chat_message_join VALUES (?, ?, ?)").run(
        info.lastInsertRowid,
        msgId,
        date,
      );
    };

    // 30 NEWEST chat rows all share one identifier → merge into ONE conversation.
    for (let i = 0; i < 30; i++) {
      addChatWithMessage(`iMessage;-;+15551119999;leg${i}`, "+15551119999", 1000 + i);
    }
    // 5 older, distinct conversations.
    for (let i = 0; i < 5; i++) {
      addChatWithMessage(`iMessage;-;+1555222000${i}`, `+1555222000${i}`, i);
    }
    cd.close();

    const db = new IMessageDB(chatDb, [], slugsDb);
    try {
      // Old behaviour: candidates = 5*3 = 15 (all heavy-merge legs) → deduped
      // to 1 → page starved at 1 row. Must return the requested 5.
      const conversations = await db.listConversations(5);
      expect(conversations).toHaveLength(5);
      const identifiers = conversations.map((c) => c.chatIdentifier);
      expect(new Set(identifiers).size).toBe(5);
      expect(identifiers[0]).toBe("+15551119999"); // merged row first (newest)
    } finally {
      await db.close();
    }
  });
});
