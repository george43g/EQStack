/**
 * Per-thread info / attachment drawer (feature A4).
 *
 * Two layers:
 *  1. DB — `listConversationAttachments` returns every non-sticker,
 *     non-plugin attachment in a thread, newest-first.
 *  2. UI — `InfoDrawer` renders thread metadata + a browsable attachment list
 *     with a ▸ cursor on the selected row.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { render } from "ink-testing-library";
import { afterAll, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";
import { InfoDrawer } from "../src/tui/components/InfoDrawer.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { ChatStats, Conversation, ConversationAttachment } from "../src/types.js";

const MAC_EPOCH_OFFSET = 978_307_200;
const macSecs = (d: Date) => Math.floor(d.getTime() / 1000) - MAC_EPOCH_OFFSET;
const NANOS = 1_000_000_000;
const macNanos = (d: Date) => Math.floor((d.getTime() / 1000 - MAC_EPOCH_OFFSET) * NANOS);

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeFixture(): { chatDb: string; slugsDb: string; phone: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-att-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const slugsDb = join(dir, "slugs.db");
  const phone = "+15550002222";
  const cd = new Database(chatDb);
  cd.exec(`
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
      style INTEGER, state INTEGER, account_id TEXT, properties BLOB,
      chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT,
      is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT,
      group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER,
      last_read_message_timestamp INTEGER DEFAULT 0
    );
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT,
      service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service)
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0,
      attributedBody BLOB, type INTEGER DEFAULT 0, service TEXT, error INTEGER DEFAULT 0,
      date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0,
      is_from_me INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0,
      associated_message_emoji TEXT, balloon_bundle_id TEXT, payload_data BLOB, message_summary_info BLOB,
      reply_to_guid TEXT, thread_originator_guid TEXT, thread_originator_part TEXT,
      date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0, is_edited INTEGER DEFAULT 0
    );
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
    CREATE TABLE chat_message_join (
      chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id)
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
  ).run(`iMessage;-;${phone}`, phone);
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();

  const mkMsg = (id: number, d: Date) => {
    cd.prepare(
      "INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, cache_has_attachments) VALUES (?, ?, '', 1, ?, 0, 1)",
    ).run(id, `g-${id}`, macNanos(d));
    cd.prepare("INSERT INTO chat_message_join VALUES (1, ?, ?)").run(id, macNanos(d));
  };
  const mkAtt = (
    id: number,
    msgId: number,
    d: Date,
    mime: string,
    name: string,
    opts: { sticker?: number; uti?: string } = {},
  ) => {
    cd.prepare(
      "INSERT INTO attachment (ROWID, filename, mime_type, transfer_name, total_bytes, created_date, is_sticker, uti) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      `/tmp/${name}`,
      mime,
      name,
      1024 * id,
      macSecs(d),
      opts.sticker ?? 0,
      opts.uti ?? "public.data",
    );
    cd.prepare("INSERT INTO message_attachment_join VALUES (?, ?)").run(msgId, id);
  };

  const older = new Date(Date.UTC(2025, 0, 1));
  const newer = new Date(Date.UTC(2025, 5, 1));
  mkMsg(1, older);
  mkMsg(2, newer);
  mkAtt(10, 1, older, "image/jpeg", "photo.jpg");
  mkAtt(11, 2, newer, "video/mp4", "clip.mp4");
  mkAtt(12, 2, newer, "image/png", "sticker.png", { sticker: 1 }); // excluded
  mkAtt(13, 2, newer, "text/x", "plugin.bin", { uti: "com.apple.messages.plugin.url" }); // excluded
  cd.close();
  return { chatDb, slugsDb, phone };
}

describe("listConversationAttachments", () => {
  it("returns non-sticker, non-plugin attachments newest-first", async () => {
    const { chatDb, slugsDb, phone } = makeFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const atts = db.listConversationAttachments(phone);
      expect(atts.map((a) => a.transferName)).toEqual(["clip.mp4", "photo.jpg"]); // newest first
      expect(atts.map((a) => a.rowId)).toEqual([11, 10]);
      // sticker (12) + plugin (13) excluded
      expect(atts.some((a) => a.rowId === 12 || a.rowId === 13)).toBe(false);
      expect(atts[0].mimeType).toBe("video/mp4");
    } finally {
      await db.close();
    }
  });
});

describe("InfoDrawer render", () => {
  const conv: Conversation = {
    chatId: "iMessage;-;+15550001111",
    chatIdentifier: "+15550001111",
    displayName: "Alice Example",
    rawIdentifier: "+15550001111",
    participants: ["+15550001111"],
    lastMessageDate: new Date("2025-06-01"),
    lastMessageSnippet: null,
    unreadCount: 0,
    threadSlug: "alice-example~imsg~a1b2",
    isGroupChat: false,
    serviceType: "iMessage",
  };
  const stats: ChatStats = {
    count: 1234,
    first: new Date("2020-01-15T00:00:00Z"),
    last: new Date("2025-06-01T00:00:00Z"),
  };
  const attachments: ConversationAttachment[] = [
    {
      rowId: 11,
      filename: "/tmp/clip.mp4",
      mimeType: "video/mp4",
      transferName: "clip.mp4",
      totalBytes: 1_048_576,
      createdDate: new Date("2025-06-01T00:00:00Z"),
    },
    {
      rowId: 10,
      filename: "/tmp/photo.jpg",
      mimeType: "image/jpeg",
      transferName: "photo.jpg",
      totalBytes: 2048,
      createdDate: new Date("2025-01-01T00:00:00Z"),
    },
  ];

  it("renders metadata + a browsable attachment list with a ▸ cursor", () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <InfoDrawer
          conversation={conv}
          resolvedNames={["Alice Example"]}
          stats={stats}
          attachments={attachments}
          selectedAttachmentIdx={0}
          width={54}
          height={30}
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thread Info");
    for (const label of ["Name:", "Slug:", "Service:", "Messages:", "Range:"]) {
      expect(frame, `missing "${label}"`).toContain(label);
    }
    expect(frame).toContain("alice-example~imsg~a1b2");
    expect(frame).toContain("iMessage");
    expect(frame).toContain("Attachments (2)");
    expect(frame).toContain("clip.mp4");
    expect(frame).toContain("photo.jpg");
    expect(frame).toContain("▸"); // selection cursor on the first (selected) row
    unmount();
  });

  it("shows an empty-state when the thread has no attachments", () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <InfoDrawer
          conversation={conv}
          resolvedNames={["Alice Example"]}
          stats={stats}
          attachments={[]}
          selectedAttachmentIdx={0}
          width={54}
          height={30}
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Attachments (0)");
    expect(frame).toContain("No attachments in this thread.");
    unmount();
  });
});
