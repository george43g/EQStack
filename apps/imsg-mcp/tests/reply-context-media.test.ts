/**
 * Stage 1 — Apple-native media extraction wired through the DB layer:
 *   1. A reply to a VOICE NOTE surfaces replyToKind="voice-note" + Apple's
 *      transcript as replyToText (was: replyToText=null → TUI "(unknown)").
 *   2. A reply to an IMAGE/VIDEO/file surfaces the right replyToKind.
 *   3. A voice-note message itself carries appleAudioTranscript.
 *   4. A Genmoji attachment surfaces emojiDescription.
 *   5. A LEGACY schema (no is_audio_message / emoji column) still resolves
 *      text replies without crashing (hasColumn guard).
 *
 * All attributedBody blobs are SYNTHESIZED from the public IMAudioTranscription
 * framing — no real transcript content is embedded.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { IMessageDB } from "../src/imessage-db.js";

const NANOS_PER_SECOND = 1_000_000_000;
const MAC_EPOCH_OFFSET = 978_307_200;
const macTs = (d: Date) => Math.floor((d.getTime() / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);

const MARKER = Buffer.from("IMAudioTranscription", "ascii");
const FRAMING = Buffer.from([0x86, 0x92, 0x84, 0x96, 0x96]);
/** Build a synthetic voice-note attributedBody carrying a transcript. */
function transcriptBlob(text: string): Buffer {
  const utf8 = Buffer.from(text, "utf8");
  const len =
    utf8.length < 0x81
      ? Buffer.from([utf8.length])
      : Buffer.from([0x81, utf8.length & 0xff, (utf8.length >>> 8) & 0xff]);
  return Buffer.concat([Buffer.from([0x04, 0x0b, 0x99]), MARKER, FRAMING, len, utf8]);
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const MODERN_MESSAGE_COLS = `
  ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE NOT NULL,
  text TEXT, handle_id INTEGER DEFAULT 0, attributedBody BLOB,
  type INTEGER DEFAULT 0, service TEXT DEFAULT 'iMessage', error INTEGER DEFAULT 0,
  date INTEGER, date_read INTEGER, date_delivered INTEGER,
  is_delivered INTEGER DEFAULT 1, is_from_me INTEGER DEFAULT 0,
  is_read INTEGER DEFAULT 1, cache_has_attachments INTEGER DEFAULT 0,
  item_type INTEGER DEFAULT 0, associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0, associated_message_emoji TEXT,
  balloon_bundle_id TEXT, payload_data BLOB, message_summary_info BLOB,
  reply_to_guid TEXT, thread_originator_guid TEXT, thread_originator_part TEXT,
  date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0`;

function baseSchema(cd: Database.Database, opts: { audioCol: boolean; emojiCol: boolean }) {
  cd.exec(`
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
      style INTEGER, state INTEGER, chat_identifier TEXT, service_name TEXT,
      display_name TEXT, room_name TEXT
    );
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL,
      service TEXT NOT NULL, UNIQUE (id, service)
    );
    CREATE TABLE message (${MODERN_MESSAGE_COLS}${opts.audioCol ? ", is_audio_message INTEGER DEFAULT 0" : ""});
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
    CREATE TABLE chat_message_join (
      chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT,
      total_bytes INTEGER, created_date INTEGER, is_sticker INTEGER DEFAULT 0, uti TEXT${
        opts.emojiCol ? ", emoji_image_short_description TEXT" : ""
      }
    );
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'iMessage')").run(
    "+15550001234",
  );
  cd.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'iMessage', 45)",
  ).run("iMessage;-;+15550001234", "+15550001234");
  cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
}

const VOICE_TEXT = "Hey just confirming the plan for tomorrow works great see you then";

function makeModernFixture(): { chatDb: string; slugsDb: string } {
  const dir = mkdtempSync(join(tmpdir(), "imsg-reply-media-"));
  tempDirs.push(dir);
  const chatDb = join(dir, "chat.db");
  const slugsDb = join(dir, "slugs.db");
  const cd = new Database(chatDb);
  baseSchema(cd, { audioCol: true, emojiCol: true });

  const base = macTs(new Date(Date.UTC(2026, 5, 1)));
  const mkMsg = (row: {
    id: number;
    guid: string;
    text: string | null;
    fromMe?: number;
    off: number;
    attributedBody?: Buffer | null;
    isAudio?: number;
    hasAtt?: number;
    replyTo?: string;
  }) => {
    const date = base + row.off * NANOS_PER_SECOND;
    cd.prepare(`
      INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, date, is_from_me,
        is_audio_message, cache_has_attachments, thread_originator_guid, item_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      row.id,
      row.guid,
      row.text,
      row.attributedBody ?? null,
      row.fromMe ? null : 1,
      date,
      row.fromMe ?? 0,
      row.isAudio ?? 0,
      row.hasAtt ?? 0,
      row.replyTo ?? null,
    );
    cd.prepare("INSERT INTO chat_message_join VALUES (1, ?, ?)").run(row.id, date);
  };

  // 1. Voice-note original (no text) + a reply to it.
  mkMsg({
    id: 1,
    guid: "vn1",
    text: null,
    off: 0,
    attributedBody: transcriptBlob(VOICE_TEXT),
    isAudio: 1,
  });
  mkMsg({ id: 2, guid: "r1", text: "great!", fromMe: 1, off: 10, replyTo: "vn1" });

  // 2. Image original + reply.
  mkMsg({ id: 3, guid: "img1", text: null, off: 20, hasAtt: 1 });
  cd.prepare(
    "INSERT INTO attachment (ROWID, filename, mime_type, is_sticker, uti) VALUES (10, 'p.jpg', 'image/jpeg', 0, 'public.jpeg')",
  ).run();
  cd.prepare("INSERT INTO message_attachment_join VALUES (3, 10)").run();
  mkMsg({ id: 4, guid: "r2", text: "nice pic", fromMe: 1, off: 30, replyTo: "img1" });

  // 3. Genmoji message.
  mkMsg({ id: 5, guid: "gm1", text: null, off: 40, hasAtt: 1 });
  cd.prepare(
    "INSERT INTO attachment (ROWID, filename, mime_type, is_sticker, uti, emoji_image_short_description) VALUES (11, 'g.png', 'image/png', 0, 'public.png', 'a smiling cactus')",
  ).run();
  cd.prepare("INSERT INTO message_attachment_join VALUES (5, 11)").run();

  cd.close();
  return { chatDb, slugsDb };
}

describe("reply-context media extraction (Stage 1)", () => {
  it("surfaces a reply to a voice note with kind + Apple transcript", async () => {
    const { chatDb, slugsDb } = makeModernFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const msgs = await db.getMessagesForChat("+15550001234", 50);
      const reply = msgs.find((m) => m.guid === "r1");
      expect(reply?.replyTo?.replyToKind).toBe("voice-note");
      expect(reply?.replyTo?.replyToText).toBe(VOICE_TEXT);
    } finally {
      await db.close();
    }
  });

  it("surfaces a reply to an image with kind=image", async () => {
    const { chatDb, slugsDb } = makeModernFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const msgs = await db.getMessagesForChat("+15550001234", 50);
      const reply = msgs.find((m) => m.guid === "r2");
      expect(reply?.replyTo?.replyToKind).toBe("image");
    } finally {
      await db.close();
    }
  });

  it("populates appleAudioTranscript on the voice-note message itself", async () => {
    const { chatDb, slugsDb } = makeModernFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const msgs = await db.getMessagesForChat("+15550001234", 50);
      const vn = msgs.find((m) => m.guid === "vn1");
      expect(vn?.appleAudioTranscript).toBe(VOICE_TEXT);
    } finally {
      await db.close();
    }
  });

  it("surfaces the Genmoji short description on the attachment", async () => {
    const { chatDb, slugsDb } = makeModernFixture();
    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const msgs = await db.getMessagesForChat("+15550001234", 50);
      const gm = msgs.find((m) => m.guid === "gm1");
      expect(gm?.attachments?.[0]?.emojiDescription).toBe("a smiling cactus");
    } finally {
      await db.close();
    }
  });

  it("resolves text replies on a LEGACY schema without the new columns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imsg-reply-legacy-"));
    tempDirs.push(dir);
    const chatDb = join(dir, "chat.db");
    const slugsDb = join(dir, "slugs.db");
    const cd = new Database(chatDb);
    baseSchema(cd, { audioCol: false, emojiCol: false });
    const base = macTs(new Date(Date.UTC(2026, 5, 1)));
    const ins = (id: number, guid: string, text: string | null, off: number, replyTo?: string) => {
      const date = base + off * NANOS_PER_SECOND;
      cd.prepare(
        `INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me, thread_originator_guid, item_type)
         VALUES (?, ?, ?, 1, ?, 0, ?, 0)`,
      ).run(id, guid, text, date, replyTo ?? null);
      cd.prepare("INSERT INTO chat_message_join VALUES (1, ?, ?)").run(id, date);
    };
    ins(1, "o1", "original question", 0);
    ins(2, "r1", "reply text", 10, "o1");
    cd.close();

    const db = new IMessageDB(chatDb, undefined, slugsDb);
    try {
      const msgs = await db.getMessagesForChat("+15550001234", 50);
      const reply = msgs.find((m) => m.guid === "r1");
      expect(reply?.replyTo?.replyToText).toBe("original question");
      expect(reply?.replyTo?.replyToKind).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});
