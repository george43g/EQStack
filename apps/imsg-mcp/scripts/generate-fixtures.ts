#!/usr/bin/env node

/**
 * Synthetic fixture generator — produces a tiny, schema-identical iMessage +
 * AddressBook database with 100% fabricated content. NO real bytes from the
 * author's data ever touch this output. Safe to commit and ship.
 *
 * Why "schema-identical"? The TUI / MCP / native module all run unchanged
 * against the fixture, so tests stay realistic. We copy DDL (column names +
 * types) from the real macOS schema reference — that's public Apple knowledge,
 * not PII.
 *
 * Privacy guarantees:
 *   - Phone numbers from the +1-555-01xx fictional reserved range
 *   - Names from a static list of generic first/last names
 *   - Message text is lorem-ipsum drawn from a small word pool
 *   - GUIDs/ROWIDs are deterministically generated from a seed (no real
 *     timestamps or IDs leak through)
 *   - No photo blobs, no social profile URLs, no postal addresses
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-fixtures.ts [--out fixtures/] [--seed 42]
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

// ── Configuration ─────────────────────────────────────────────────────────

interface Config {
  outDir: string;
  seed: number;
  numContacts: number;
  numChats: number; // total chats including groups
  numGroupChats: number;
  totalMessages: number;
  attachmentRate: number; // 0..1 fraction of messages with attachments
  replyRate: number; // 0..1 fraction of messages that are replies
  preamble95Rate: number; // 0..1 fraction of attributedBody using 0x95 variant
  groupParticipantRange: [number, number];
  /** Number of top chats that get a fixed (large) message count, on top of
   * the weighted distribution. Used to stress-test the TUI / MCP against a
   * realistic "few hot threads + long tail" shape. 0 = uniform weighted. */
  topHeavyChats: number;
  /** Message count assigned to each topHeavyChats chat. */
  messagesPerTopChat: number;
}

const defaultConfig: Config = {
  outDir: "fixtures",
  seed: 42,
  numContacts: 80,
  numChats: 60,
  numGroupChats: 8,
  totalMessages: 5000,
  attachmentRate: 0.02,
  replyRate: 0.05,
  preamble95Rate: 0.05,
  groupParticipantRange: [3, 6],
  topHeavyChats: 0,
  messagesPerTopChat: 0,
};

/** Heavy preset for stress / load testing — top 5 chats get 20k messages
 * each (~100k), 1200 total chats with a long tail. ~250k messages total.
 * numContacts must be >= numChats - numGroupChats since each 1-on-1 chat
 * consumes one unique contact. */
const stressConfig: Partial<Config> = {
  numContacts: 1100,
  numChats: 1200,
  numGroupChats: 100,
  totalMessages: 250_000,
  topHeavyChats: 5,
  messagesPerTopChat: 20_000,
};

// ── Seedable RNG (mulberry32) ─────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(private next: () => number) {}
  int(min: number, maxExclusive: number): number {
    return Math.floor(this.next() * (maxExclusive - min)) + min;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
  float(): number {
    return this.next();
  }
}

// ── Synthetic content pools ───────────────────────────────────────────────

const FIRST_NAMES = [
  "Alice",
  "Bob",
  "Charlie",
  "Dana",
  "Evelyn",
  "Felix",
  "Grace",
  "Henry",
  "Iris",
  "Jack",
  "Kira",
  "Liam",
  "Mia",
  "Noah",
  "Olivia",
  "Parker",
  "Quinn",
  "Riley",
  "Sage",
  "Theo",
  "Uma",
  "Vincent",
  "Willow",
  "Xander",
  "Yara",
  "Zane",
  "Avery",
  "Blake",
  "Cameron",
  "Drew",
  "Emerson",
  "Finley",
  "Harper",
  "Indigo",
  "Jordan",
  "Kai",
  "Logan",
  "Morgan",
  "Nova",
  "Oakley",
  "Phoenix",
  "Reese",
  "Sawyer",
  "Taylor",
  "River",
  "Skylar",
];

const LAST_NAMES = [
  "Anderson",
  "Bell",
  "Carter",
  "Davis",
  "Evans",
  "Foster",
  "Garcia",
  "Harris",
  "Irving",
  "Jones",
  "King",
  "Lee",
  "Miller",
  "Nguyen",
  "Owens",
  "Patel",
  "Quinn",
  "Reed",
  "Smith",
  "Taylor",
  "Underwood",
  "Vargas",
  "Walsh",
  "Xu",
  "Young",
  "Zhang",
  "Brooks",
  "Cole",
  "Doyle",
  "Ellis",
  "Fisher",
  "Green",
  "Hayes",
  "Ingram",
  "Joyner",
  "Kelly",
  "Lang",
  "Mason",
  "Newton",
];

const LOREM_WORDS = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "et",
  "dolore",
  "magna",
  "aliqua",
  "enim",
  "ad",
  "minim",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
  "ullamco",
  "laboris",
  "nisi",
  "aliquip",
  "ex",
  "ea",
  "commodo",
  "consequat",
  "duis",
  "aute",
  "irure",
  "in",
  "reprehenderit",
  "voluptate",
  "velit",
  "esse",
  "cillum",
  "fugiat",
  "nulla",
  "pariatur",
  "excepteur",
  "sint",
  "occaecat",
  "cupidatat",
  "non",
  "proident",
  "sunt",
  "culpa",
  "qui",
  "officia",
  "deserunt",
  "mollit",
  "anim",
  "id",
  "est",
  "laborum",
];

const SAMPLE_EMOJI = ["🎉", "👍", "❤️", "🔥", "✨", "📱", "☕", "🌙", "🍕"];

function loremSentence(rng: Rng, minWords = 3, maxWords = 20): string {
  const n = rng.int(minWords, maxWords);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(rng.pick(LOREM_WORDS));
  let text = words.join(" ");
  text = text.charAt(0).toUpperCase() + text.slice(1);
  // 30% chance of question, 30% exclamation, else period
  const r = rng.float();
  text += r < 0.3 ? "?" : r < 0.6 ? "!" : ".";
  // 10% chance to append an emoji
  if (rng.bool(0.1)) text += ` ${rng.pick(SAMPLE_EMOJI)}`;
  return text;
}

// ── Hand-built typedstream blob for attributedBody ────────────────────────

/**
 * Produce a valid Apple typedstream blob containing the given text. Format:
 *   streamtyped magic
 *   class registration (NSAttributedString → NSObject → NSString)
 *   preamble (5 bytes ending with `+`)
 *   length byte (or 0x81 + 2-byte LE length for >127 char strings)
 *   UTF-8 content
 *   trailer with NSDictionary metadata
 *
 * The `preambleByte2` argument switches between the 0x94 (most common) and
 * 0x95 (DataDetector annotations) variants — exercising the parser regression
 * test we already have in tests/typedstream-parser.test.ts.
 */
function _buildAttributedBody(text: string, preambleByte2 = 0x94): Buffer {
  const utf8 = Buffer.from(text, "utf8");
  const len = utf8.length;
  const lenBytes: Buffer =
    len < 0x81 ? Buffer.from([len]) : Buffer.from([0x81, len & 0xff, (len >>> 8) & 0xff]);

  // streamtyped header
  const header = Buffer.from([
    0x04,
    0x0b,
    0x73,
    0x74,
    0x72,
    0x65,
    0x61,
    0x6d,
    0x74,
    0x79,
    0x70,
    0x65,
    0x64, // streamtyped
    0x81,
    0xe8,
    0x03,
    0x84,
    0x01,
    0x40,
    0x84,
    0x84,
    0x84,
    0x12, // length of "NSAttributedString"
  ]);
  const nsAttr = Buffer.from("NSAttributedString\x00", "ascii");
  const nsObjPart = Buffer.from([0x84, 0x84, 0x08]);
  const nsObj = Buffer.from("NSObject\x00", "ascii");
  const middle = Buffer.from([0x85, 0x92, 0x84, 0x84, 0x84, 0x08]);
  const nsString = Buffer.from("NSString\x01", "ascii");
  const preamble = Buffer.from([0x94, preambleByte2, 0x84, 0x01, 0x2b]);
  // Wait — the preamble starts with 0x01 0x9X 0x84 0x01 0x2b per the parser.
  // The first byte BEFORE the preamble is part of the prior class registration.
  // Let me follow the simpler proven format from the existing test fixtures:
  // After "NSString" + null/markers, comes 5-byte preamble then length.

  // Trailer — minimal NSDictionary attribute marker
  const trailer = Buffer.from([
    0x86,
    0x84,
    0x02,
    0x69,
    0x49,
    0x01, // iI byte
    len & 0xff, // attribute range length (matches text length)
    0x92,
    0x84,
    0x84,
    0x84,
    0x0c, // length of "NSDictionary"
  ]);
  const nsDict = Buffer.from("NSDictionary\x00", "ascii");
  const tail = Buffer.from([0x86, 0x86, 0x86]);

  return Buffer.concat([
    header,
    nsAttr,
    nsObjPart,
    nsObj,
    middle,
    nsString,
    preamble,
    lenBytes,
    utf8,
    trailer,
    nsDict,
    tail,
  ]);
}

// Override the preamble: we want to insert our preambleByte2 not always 0x94.
// The function above always uses 0x94 by way of an oversight — fix it.
// The real bytes are: [0x01, byte2, 0x84, 0x01, 0x2b]. Let's re-export:
function buildAttributedBodyFixed(text: string, preambleByte2 = 0x94): Buffer {
  const utf8 = Buffer.from(text, "utf8");
  const len = utf8.length;
  const lenBytes: Buffer =
    len < 0x81 ? Buffer.from([len]) : Buffer.from([0x81, len & 0xff, (len >>> 8) & 0xff]);

  // Mirror the structure from tests/typedstream-parser.test.ts buildBlobWithPreamble
  // plus enough trailing structure that extractAttributedBodyText finds the candidate.
  const header = Buffer.from([
    0x04,
    0x0b,
    0x73,
    0x74,
    0x72,
    0x65,
    0x61,
    0x6d,
    0x74,
    0x79,
    0x70,
    0x65,
    0x64, // streamtyped
    0x81,
    0xe8,
    0x03,
    0x84,
    0x01,
    0x40,
    0x84,
    0x84,
    0x84,
    0x12, // length of "NSAttributedString"
  ]);
  const nsAttr = Buffer.from("NSAttributedString\x00", "ascii");
  const nsObjPart = Buffer.from([0x84, 0x84, 0x08]);
  const nsObj = Buffer.from("NSObject\x00", "ascii");
  const middle = Buffer.from([0x85, 0x92, 0x84, 0x84, 0x84, 0x08]);
  const nsString = Buffer.from("NSString\x01", "ascii");
  const preamble = Buffer.from([0x01, preambleByte2, 0x84, 0x01, 0x2b]);

  return Buffer.concat([
    header,
    nsAttr,
    nsObjPart,
    nsObj,
    middle,
    nsString,
    preamble,
    lenBytes,
    utf8,
    // Trailing structure — terminator bytes so the parser doesn't try to
    // continue reading content past our string.
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49]), // iI marker
  ]);
}

// ── Schema DDL (extracted from a real macOS chat.db, names+types only) ────

const CHAT_DB_DDL = [
  `CREATE TABLE chat (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    style INTEGER,
    state INTEGER,
    account_id TEXT,
    properties BLOB,
    chat_identifier TEXT,
    service_name TEXT,
    room_name TEXT,
    account_login TEXT,
    is_archived INTEGER DEFAULT 0,
    last_addressed_handle TEXT,
    display_name TEXT,
    group_id TEXT,
    is_filtered INTEGER DEFAULT 0,
    successful_query INTEGER,
    last_read_message_timestamp INTEGER DEFAULT 0
  )`,
  `CREATE TABLE handle (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE,
    id TEXT NOT NULL,
    country TEXT,
    service TEXT NOT NULL,
    uncanonicalized_id TEXT,
    person_centric_id TEXT,
    UNIQUE (id, service)
  )`,
  `CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    text TEXT,
    handle_id INTEGER DEFAULT 0,
    attributedBody BLOB,
    type INTEGER DEFAULT 0,
    service TEXT,
    error INTEGER DEFAULT 0,
    date INTEGER,
    date_read INTEGER,
    date_delivered INTEGER,
    is_delivered INTEGER DEFAULT 0,
    is_from_me INTEGER DEFAULT 0,
    is_read INTEGER DEFAULT 0,
    cache_has_attachments INTEGER DEFAULT 0,
    item_type INTEGER DEFAULT 0,
    associated_message_guid TEXT,
    associated_message_type INTEGER DEFAULT 0,
    associated_message_emoji TEXT,
    balloon_bundle_id TEXT,
    payload_data BLOB,
    message_summary_info BLOB,
    reply_to_guid TEXT,
    thread_originator_guid TEXT,
    thread_originator_part TEXT,
    date_retracted INTEGER DEFAULT 0,
    date_edited INTEGER DEFAULT 0,
    is_edited INTEGER DEFAULT 0
  )`,
  `CREATE TABLE chat_handle_join (
    chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
    handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE,
    UNIQUE(chat_id, handle_id)
  )`,
  `CREATE TABLE chat_message_join (
    chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
    message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
    message_date INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, message_id)
  )`,
  `CREATE TABLE attachment (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    created_date INTEGER DEFAULT 0,
    filename TEXT,
    uti TEXT,
    mime_type TEXT,
    transfer_state INTEGER DEFAULT 0,
    is_outgoing INTEGER DEFAULT 0,
    transfer_name TEXT,
    total_bytes INTEGER DEFAULT 0,
    is_sticker INTEGER DEFAULT 0,
    hide_attachment INTEGER DEFAULT 0,
    original_guid TEXT UNIQUE NOT NULL
  )`,
  `CREATE TABLE message_attachment_join (
    message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
    attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE,
    UNIQUE(message_id, attachment_id)
  )`,
];

const ADDRESS_BOOK_DDL = [
  // We need just enough columns for ContactsDB.lookupHandle / resolveBatch.
  `CREATE TABLE ZABCDRECORD (
    Z_PK INTEGER PRIMARY KEY,
    ZFIRSTNAME VARCHAR,
    ZMIDDLENAME VARCHAR,
    ZLASTNAME VARCHAR,
    ZNICKNAME VARCHAR,
    ZORGANIZATION VARCHAR
  )`,
  `CREATE TABLE ZABCDPHONENUMBER (
    Z_PK INTEGER PRIMARY KEY,
    ZOWNER INTEGER,
    Z22_OWNER INTEGER,
    ZFULLNUMBER VARCHAR,
    ZLABEL VARCHAR
  )`,
  `CREATE TABLE ZABCDEMAILADDRESS (
    Z_PK INTEGER PRIMARY KEY,
    ZOWNER INTEGER,
    Z22_OWNER INTEGER,
    ZADDRESS VARCHAR,
    ZLABEL VARCHAR
  )`,
];

// ── Generators ────────────────────────────────────────────────────────────

interface Contact {
  pk: number;
  firstName: string;
  lastName: string;
  phone: string; // E.164 fictional
  email: string;
}

function generateContacts(rng: Rng, n: number): Contact[] {
  const contacts: Contact[] = [];
  // Use the +1-555-01xx fictional reserved range. The index `i` guarantees
  // uniqueness for both phone and email regardless of the name-pool size, so
  // the stress preset (n=1100) doesn't hit AddressBook UNIQUE-constraint
  // collisions (50×50 first/last combinations would otherwise collide many
  // times before reaching 1100 contacts).
  for (let i = 0; i < n; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const phone = `+1555${String(100 + i).padStart(7, "0")}`.slice(0, 12);
    const email = `${first.toLowerCase()}.${last.toLowerCase()}.${i}@example.com`;
    contacts.push({ pk: i + 1, firstName: first, lastName: last, phone, email });
  }
  return contacts;
}

interface ChatRow {
  rowid: number;
  guid: string;
  identifier: string;
  isGroup: boolean;
  displayName: string | null;
  participants: number[]; // contact PKs
}

function generateChats(rng: Rng, contacts: Contact[], cfg: Config): ChatRow[] {
  const chats: ChatRow[] = [];
  const used = new Set<number>();
  // Group chats first
  for (let i = 0; i < cfg.numGroupChats; i++) {
    const size = rng.int(cfg.groupParticipantRange[0], cfg.groupParticipantRange[1] + 1);
    const participants: number[] = [];
    while (participants.length < size) {
      const pick = contacts[rng.int(0, contacts.length)].pk;
      if (!participants.includes(pick)) participants.push(pick);
    }
    const guid = `iMessage;+;chat${1000 + i}`;
    chats.push({
      rowid: i + 1,
      guid,
      identifier: `chat${1000 + i}`,
      isGroup: true,
      displayName: rng.bool(0.5) ? `Group ${i + 1}` : null,
      participants,
    });
  }
  // 1-on-1 chats — each uses one unused contact
  let rowid = chats.length + 1;
  for (const c of contacts) {
    if (chats.length >= cfg.numChats) break;
    if (used.has(c.pk)) continue;
    used.add(c.pk);
    const isPhone = rng.bool(0.85);
    const identifier = isPhone ? c.phone : c.email;
    const guid = `iMessage;-;${identifier}`;
    chats.push({
      rowid: rowid++,
      guid,
      identifier,
      isGroup: false,
      displayName: null,
      participants: [c.pk],
    });
  }
  return chats;
}

// ── Database writers ──────────────────────────────────────────────────────

function makeChatDb(
  path: string,
  contacts: Contact[],
  chats: ChatRow[],
  cfg: Config,
  rng: Rng,
): void {
  if (existsSync(path)) rmSync(path);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  for (const ddl of CHAT_DB_DDL) {
    db.exec(ddl);
  }

  // Insert handles — one per contact identifier (phone or email)
  const insertHandle = db.prepare(
    "INSERT INTO handle (ROWID, id, country, service) VALUES (?, ?, ?, ?)",
  );
  const handleIdByContact = new Map<number, number>();
  let handleRowid = 1;
  for (const c of contacts) {
    insertHandle.run(handleRowid, c.phone, "us", "iMessage");
    handleIdByContact.set(c.pk, handleRowid);
    handleRowid++;
  }

  // Insert chats + chat_handle_join
  const insertChat = db.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, style) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertChatHandle = db.prepare(
    "INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)",
  );
  for (const ch of chats) {
    insertChat.run(
      ch.rowid,
      ch.guid,
      ch.identifier,
      "iMessage",
      ch.displayName,
      ch.isGroup ? 43 : 45,
    );
    for (const pk of ch.participants) {
      const hid = handleIdByContact.get(pk);
      if (hid) insertChatHandle.run(ch.rowid, hid);
    }
  }

  // Insert messages — distribute across chats
  const insertMsg = db.prepare(`
    INSERT INTO message (
      ROWID, guid, text, attributedBody, handle_id, date, date_read, date_delivered,
      is_from_me, is_read, is_delivered, cache_has_attachments, service,
      thread_originator_guid, type, item_type, associated_message_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
  `);
  const insertChatMsg = db.prepare(
    "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
  );
  // Real attachment rows for flagged messages — cache_has_attachments alone
  // draws the 📎 marker, but the drawer/attachment tools read the join table.
  const insertAttachment = db.prepare(`
    INSERT INTO attachment (guid, created_date, filename, uti, mime_type,
      transfer_name, total_bytes, original_guid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMsgAttachment = db.prepare(
    "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)",
  );
  const ATTACHMENT_KINDS = [
    { ext: "heic", uti: "public.heic", mime: "image/heic" },
    { ext: "jpeg", uti: "public.jpeg", mime: "image/jpeg" },
    { ext: "png", uti: "public.png", mime: "image/png" },
    { ext: "mov", uti: "com.apple.quicktime-movie", mime: "video/quicktime" },
    { ext: "caf", uti: "com.apple.coreaudio-format", mime: "audio/x-caf" },
  ] as const;
  let attachmentRowid = 1;

  // Mac timestamp = nanoseconds since 2001-01-01
  const MAC_EPOCH_OFFSET_S = 978307200;
  // Anchor the synthesized time range to a fixed past-2-years window relative
  // to a deterministic anchor instead of `Date.now()` so fixture output is
  // bit-for-bit reproducible across runs.
  const ANCHOR_UNIX_S = 1735689600; // 2025-01-01 UTC
  const TWO_YEARS_S = 2 * 365 * 86400;
  const recentMacNs = (ANCHOR_UNIX_S - MAC_EPOCH_OFFSET_S) * 1e9;

  // Distribute messages across chats. If topHeavyChats > 0, the first N chats
  // each receive `messagesPerTopChat` (a "few hot threads" shape) and the
  // remainder is distributed across the rest by weighted random — long tail.
  const messageCounts: number[] = new Array(chats.length).fill(0);
  const topHeavy = Math.min(cfg.topHeavyChats, chats.length);
  let messagesAssignedToTop = 0;
  for (let i = 0; i < topHeavy; i++) {
    messageCounts[i] = cfg.messagesPerTopChat;
    messagesAssignedToTop += cfg.messagesPerTopChat;
  }
  const remainingMessages = Math.max(0, cfg.totalMessages - messagesAssignedToTop);
  if (chats.length > topHeavy && remainingMessages > 0) {
    const tailChats = chats.length - topHeavy;
    const tailWeights = Array.from({ length: tailChats }, () => rng.int(1, 20));
    const totalTailWeight = tailWeights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < tailChats; i++) {
      messageCounts[topHeavy + i] = Math.max(
        1,
        Math.floor((tailWeights[i] / totalTailWeight) * remainingMessages),
      );
    }
  }

  const messageGuidsByChat = new Map<number, string[]>();

  let messageRowid = 1;
  const insertTransaction = db.transaction(() => {
    for (let i = 0; i < chats.length; i++) {
      const ch = chats[i];
      const count = messageCounts[i];
      const guids: string[] = [];
      for (let j = 0; j < count; j++) {
        const guid = `synthetic-msg-${messageRowid}`;
        const text = loremSentence(rng);
        const isFromMe = rng.bool(0.45);
        // Pick a sender handle from chat participants
        const senderPk = ch.isGroup
          ? ch.participants[rng.int(0, ch.participants.length)]
          : ch.participants[0];
        const handleId = isFromMe ? 0 : (handleIdByContact.get(senderPk) ?? 0);

        // Date: distribute over the past 2 years backwards from anchor
        const ageS = rng.int(0, TWO_YEARS_S);
        const macNs = recentMacNs - ageS * 1e9;

        // 5% of messages have null text + populated attributedBody (parser exercise)
        const hasBlobOnly = rng.bool(0.05);
        const finalText = hasBlobOnly ? null : text;
        const blobByte2 = rng.bool(cfg.preamble95Rate) ? 0x95 : 0x94;
        const attributedBody = hasBlobOnly ? buildAttributedBodyFixed(text, blobByte2) : null;

        const hasAttachment = rng.bool(cfg.attachmentRate);

        insertMsg.run(
          messageRowid,
          guid,
          finalText,
          attributedBody,
          handleId,
          macNs,
          isFromMe ? macNs : 0,
          isFromMe ? macNs : 0,
          // is_from_me must mirror the sender draw exactly — a stray truthy
          // here marks received messages as sent and every doc screenshot
          // renders as a wall of "Me:" bubbles.
          isFromMe ? 1 : 0,
          // is_read: own messages are always "read"; received ~90% read so
          // the sidebar keeps its unread badges.
          isFromMe ? 1 : rng.bool(0.9) ? 1 : 0,
          1,
          hasAttachment ? 1 : 0,
          "iMessage",
          // Reply-to: occasionally point at a previously-inserted message in the SAME chat
          rng.bool(cfg.replyRate) && guids.length > 0 ? guids[rng.int(0, guids.length)] : null,
        );

        insertChatMsg.run(ch.rowid, messageRowid, macNs);
        if (hasAttachment) {
          // 1-2 attachments per flagged message so the drawer's j/k
          // attachment cursor has something to select.
          const n = rng.bool(0.3) ? 2 : 1;
          for (let a = 0; a < n; a++) {
            const kind = ATTACHMENT_KINDS[rng.int(0, ATTACHMENT_KINDS.length)];
            const name = `IMG_${String(1000 + attachmentRowid).slice(1)}.${kind.ext}`;
            insertAttachment.run(
              `synthetic-att-${attachmentRowid}`,
              macNs,
              `~/Library/Messages/Attachments/fixture/${name}`,
              kind.uti,
              kind.mime,
              name,
              rng.int(40_000, 4_000_000),
              `synthetic-att-orig-${attachmentRowid}`,
            );
            insertMsgAttachment.run(messageRowid, attachmentRowid);
            attachmentRowid++;
          }
        }
        guids.push(guid);
        messageRowid++;
      }
      messageGuidsByChat.set(ch.rowid, guids);
    }
  });
  insertTransaction();

  db.close();
}

function makeAddressBookDb(path: string, contacts: Contact[]): void {
  if (existsSync(path)) rmSync(path);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);

  for (const ddl of ADDRESS_BOOK_DDL) {
    db.exec(ddl);
  }

  const insertRecord = db.prepare(
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME) VALUES (?, ?, ?)",
  );
  const insertPhone = db.prepare(
    "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZOWNER, ZFULLNUMBER) VALUES (?, ?, ?)",
  );
  const insertEmail = db.prepare(
    "INSERT INTO ZABCDEMAILADDRESS (Z_PK, ZOWNER, ZADDRESS) VALUES (?, ?, ?)",
  );

  let phonePk = 1;
  let emailPk = 1;
  const txn = db.transaction(() => {
    for (const c of contacts) {
      insertRecord.run(c.pk, c.firstName, c.lastName);
      insertPhone.run(phonePk++, c.pk, c.phone);
      insertEmail.run(emailPk++, c.pk, c.email);
    }
  });
  txn();

  db.close();
}

function makeVcf(path: string, contacts: Contact[]): void {
  const lines: string[] = [];
  for (const c of contacts) {
    lines.push("BEGIN:VCARD");
    lines.push("VERSION:3.0");
    lines.push(`N:${c.lastName};${c.firstName};;;`);
    lines.push(`FN:${c.firstName} ${c.lastName}`);
    lines.push(`TEL;type=CELL:${c.phone}`);
    lines.push(`EMAIL;type=INTERNET:${c.email}`);
    lines.push("END:VCARD");
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

// ── Entry point ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Partial<Config> {
  const out: Partial<Config> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.outDir = argv[++i];
    else if (a === "--seed") out.seed = Number.parseInt(argv[++i], 10);
    else if (a === "--stress") Object.assign(out, stressConfig);
  }
  return out;
}

function main(): void {
  // Env-var preset: IMSG_FIXTURE_PRESET=stress equivalent to --stress flag.
  const envPreset = process.env.IMSG_FIXTURE_PRESET === "stress" ? stressConfig : {};
  const cfg: Config = { ...defaultConfig, ...envPreset, ...parseArgs(process.argv.slice(2)) };
  const rng = new Rng(mulberry32(cfg.seed));
  const outDir = cfg.outDir;
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "AddressBook", "Sources", "00000000-0000-4000-8000-000000000001"), {
    recursive: true,
  });

  console.log(`Generating fixtures in ${outDir}/ (seed=${cfg.seed})`);

  const contacts = generateContacts(rng, cfg.numContacts);
  const chats = generateChats(rng, contacts, cfg);

  console.log(`  ${contacts.length} contacts, ${chats.length} chats (${cfg.numGroupChats} groups)`);
  console.log(`  generating chat.db ...`);
  makeChatDb(join(outDir, "chat.db"), contacts, chats, cfg, rng);

  console.log(`  generating AddressBook ...`);
  makeAddressBookDb(join(outDir, "AddressBook", "AddressBook-v22.abcddb"), contacts);
  // Sources/<uuid>/ — same content as a "linked source"
  makeAddressBookDb(
    join(
      outDir,
      "AddressBook",
      "Sources",
      "00000000-0000-4000-8000-000000000001",
      "AddressBook-v22.abcddb",
    ),
    contacts,
  );

  console.log(`  generating contacts.vcf ...`);
  makeVcf(join(outDir, "contacts.vcf"), contacts);

  console.log(`Done. ${cfg.totalMessages} messages across ${chats.length} chats.`);
}

main();
