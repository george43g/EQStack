import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ContactsDB } from "../src/contacts-db.js";
import { MAC_EPOCH_OFFSET, NANOS_PER_SECOND } from "../src/db-schema.js";
import { streamExport } from "../src/exportStream.js";
import { IMessageDB } from "../src/imessage-db.js";
import { looksLikeThreadSlug } from "../src/thread-slug.js";

const flush = () => new Promise((r) => setTimeout(r, 50));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "imsg-cross-source-"));
  tempDirs.push(dir);
  return dir;
}

/** Build an Address Book DB with one card carrying the given phone/email handles. */
function makeAddressBook(
  path: string,
  card: {
    firstName: string;
    lastName: string;
    nickname?: string;
    organization?: string;
    phone?: string;
    email?: string;
    emails?: string[];
  },
): void {
  const ab = new Database(path);
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
    "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION) VALUES (1, ?, ?, ?, ?)",
  ).run(
    card.firstName || null,
    card.lastName || null,
    card.nickname ?? null,
    card.organization ?? null,
  );
  if (card.phone) {
    ab.prepare(
      "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZFULLNUMBER, ZLABEL, ZOWNER) VALUES (1, ?, '_$!<Mobile>!$_', 1)",
    ).run(card.phone);
  }
  const allEmails = [...(card.email ? [card.email] : []), ...(card.emails ?? [])];
  allEmails.forEach((email, i) => {
    ab.prepare(
      "INSERT INTO ZABCDEMAILADDRESS (Z_PK, ZADDRESS, ZLABEL, ZOWNER) VALUES (?, ?, '_$!<Home>!$_', 1)",
    ).run(i + 1, email);
  });
  ab.close();
}

describe("ContactsDB cross-source dedup", () => {
  it("keeps phone and email on the same contactId when a later source re-declares one handle", () => {
    const dir = newDir();
    const phone = "+15550000088";
    const email = "alex@example.com";

    // Source 1 (local): full card with both handles.
    const db1 = join(dir, "AddressBook-v22.abcddb");
    makeAddressBook(db1, { firstName: "Alex", lastName: "Export", phone, email });

    // Source 2 (iCloud): partial duplicate carrying only the email. Pre-fix this
    // minted a new contactId and remapped the email, splitting it from the phone.
    const db2 = join(dir, "AddressBook-v22-source2.abcddb");
    makeAddressBook(db2, { firstName: "Alex", lastName: "Export", email });

    const contacts = new ContactsDB([db1, db2]);
    contacts.initialize();

    const byPhone = contacts.lookupContact(phone);
    const byEmail = contacts.lookupContact(email);

    expect(byPhone).not.toBeNull();
    expect(byEmail).not.toBeNull();
    expect(byPhone?.contactId).toBe(byEmail?.contactId);
  });

  it("unions two previously-separate SAME-NAME contacts when a later card bridges them", () => {
    const dir = newDir();
    const phone = "+15550000077";
    const email = "bridge@example.com";

    // Source 1: a card with ONLY the phone -> contact X.
    const db1 = join(dir, "AddressBook-v22.abcddb");
    makeAddressBook(db1, { firstName: "Alex", lastName: "Export", phone });

    // Source 2: the same person's card with ONLY the email -> contact Y.
    const db2 = join(dir, "AddressBook-v22-source2.abcddb");
    makeAddressBook(db2, { firstName: "Alex", lastName: "Export", email });

    // Source 3: a card carrying BOTH handles (same name) -> unions X and Y.
    const db3 = join(dir, "AddressBook-v22-source3.abcddb");
    makeAddressBook(db3, { firstName: "Alex", lastName: "Export", phone, email });

    const contacts = new ContactsDB([db1, db2, db3]);
    contacts.initialize();

    const byPhone = contacts.lookupContact(phone);
    const byEmail = contacts.lookupContact(email);
    expect(byPhone).not.toBeNull();
    expect(byEmail).not.toBeNull();
    expect(byPhone?.contactId).toBe(byEmail?.contactId);

    // The survivor carries both handles, and the dropped id is gone.
    const survivor = contacts.getContact(byPhone?.contactId as number);
    expect(survivor?.phoneNumbers).toContain(phone);
    expect(survivor?.emails).toContain(email);
    const totalWithHandles = contacts
      .listContacts(0, 0)
      .contacts.filter((c) => c.phoneNumbers.includes(phone) || c.emails.includes(email));
    expect(totalWithHandles).toHaveLength(1);
  });

  it("does NOT union differently-named cards that share one handle (org + person)", () => {
    // Real-world shape: a person's card and their business's org card both
    // carry the same info@ email. They are different entities — the phone of
    // each must keep resolving to ITS card's name, and their contactIds must
    // stay separate (else their conversations/slugs would wrongly merge).
    const dir = newDir();
    const orgPhone = "+15550000060";
    const personPhone = "+15550000061";
    const sharedEmail = "info@acme.example.com";
    const personalEmail = "sam@personal.example.com";

    const db1 = join(dir, "AddressBook-v22.abcddb");
    makeAddressBook(db1, {
      firstName: "",
      lastName: "",
      organization: "Acme VR",
      phone: orgPhone,
      email: sharedEmail,
    });
    const db2 = join(dir, "AddressBook-v22-source2.abcddb");
    makeAddressBook(db2, {
      firstName: "Sam",
      lastName: "Smith",
      nickname: "Dad",
      phone: personPhone,
      emails: [personalEmail, sharedEmail],
    });

    const contacts = new ContactsDB([db1, db2]);
    contacts.initialize();

    // Per-handle names: each phone resolves to the card that declares it —
    // nickname-first for the person ("Dad", like Messages.app shows).
    expect(contacts.lookupContact(orgPhone)?.displayName).toBe("Acme VR");
    expect(contacts.lookupContact(personPhone)?.displayName).toBe("Dad");
    expect(contacts.lookupContact(personalEmail)?.displayName).toBe("Dad");

    // Separate identities despite the shared email.
    expect(contacts.lookupContact(orgPhone)?.contactId).not.toBe(
      contacts.lookupContact(personPhone)?.contactId,
    );

    // The shared handle stays with its first claimant (the org card).
    expect(contacts.lookupContact(sharedEmail)?.displayName).toBe("Acme VR");
  });

  it("unions a nicknamed card with a full-name card for the same person", () => {
    // Name-candidate matching: {nickname, "first last"} — a card carrying only
    // the nickname of another card's full name is still the same person.
    const dir = newDir();
    const phone = "+15550000062";
    const email = "sam.smith@example.com";

    const db1 = join(dir, "AddressBook-v22.abcddb");
    makeAddressBook(db1, { firstName: "Sam", lastName: "Smith", phone });
    const db2 = join(dir, "AddressBook-v22-source2.abcddb");
    makeAddressBook(db2, {
      firstName: "Sam",
      lastName: "Smith",
      nickname: "Sammy",
      phone,
      email,
    });

    const contacts = new ContactsDB([db1, db2]);
    contacts.initialize();

    expect(contacts.lookupContact(phone)?.contactId).toBe(contacts.lookupContact(email)?.contactId);
  });
});

/** chat.db schema subset sufficient for chat/handle/message + the joins. */
function createChatDb(path: string): Database.Database {
  const cd = new Database(path);
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
  return cd;
}

function toMacTimestamp(ms: number): number {
  return Math.floor((ms / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
}

/**
 * Reproduces the real-world topology that made a Desirée-style thread look
 * "incomplete": one contact whose card lives in a *secondary* Address Book
 * source (iCloud), carrying both a phone and an email, with the conversation
 * physically split across four chat rows — SMS + iMessage for the number AND
 * SMS + iMessage for the email (each leg routed through a different account of
 * mine). Messages.app shows this as ONE conversation; the exporter must too.
 *
 * Generalised (no contact-specific code): merge folds every chat whose handle
 * resolves to the same contactId, regardless of which source DB the card is in
 * or whether the matched handle is the phone or the email.
 */
describe("cross-handle conversation merge (number + email across sources)", () => {
  const phone = "+15550000099";
  const email = "split.person@example.com";

  function buildFixture(opts: { withContactCard: boolean }): {
    chatDb: string;
    contactDbs: string[];
    slugsDb: string;
  } {
    const dir = newDir();
    const chatDb = join(dir, "chat.db");
    const slugsDb = join(dir, "slugs.db");

    // Local source: an unrelated card. Secondary (iCloud) source: the real card
    // carrying BOTH handles — mirrors a contact that only exists in iCloud.
    const localDb = join(dir, "AddressBook-v22.abcddb");
    const sourceDb = join(dir, "AddressBook-v22-source.abcddb");
    makeAddressBook(localDb, { firstName: "Someone", lastName: "Else", phone: "+15551110000" });
    makeAddressBook(sourceDb, { firstName: "Split", lastName: "Person", phone, email });
    const contactDbs = opts.withContactCard ? [localDb, sourceDb] : [];

    const cd = createChatDb(chatDb);
    cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (1, ?, 'SMS')").run(phone);
    cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (2, ?, 'iMessage')").run(phone);
    cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (3, ?, 'SMS')").run(email);
    cd.prepare("INSERT INTO handle (ROWID, id, service) VALUES (4, ?, 'iMessage')").run(email);

    // Four chats: {SMS,iMessage} x {number,email}, each via a different account_login.
    cd.prepare(
      "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, account_login, style) VALUES (1, ?, ?, 'SMS', 'P:+15551112222', 45)",
    ).run(`SMS;-;${phone}`, phone);
    cd.prepare(
      "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, account_login, style) VALUES (2, ?, ?, 'iMessage', 'E:me@icloud.com', 45)",
    ).run(`iMessage;-;${phone}`, phone);
    cd.prepare(
      "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, account_login, style) VALUES (3, ?, ?, 'SMS', 'P:+15551112222', 45)",
    ).run(`SMS;-;${email}`, email);
    cd.prepare(
      "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, account_login, style) VALUES (4, ?, ?, 'iMessage', 'E:me@icloud.com', 45)",
    ).run(`iMessage;-;${email}`, email);
    cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1), (2, 2), (3, 3), (4, 4)").run();

    // 8 messages, one per chat per "turn", interleaved in time across all four
    // chats so a per-chat (rather than merged) walk would miss some.
    const base = Date.UTC(2025, 0, 1);
    const insert = (rowid: number, chatId: number, handleId: number, offsetSec: number) => {
      const date = toMacTimestamp(base + offsetSec * 1000);
      cd.prepare(
        "INSERT INTO message (ROWID, guid, text, handle_id, date, is_read, is_delivered, service) VALUES (?, ?, ?, ?, ?, 1, 1, 'iMessage')",
      ).run(rowid, `m${rowid}`, `msg ${rowid}`, handleId, date);
      cd.prepare("INSERT INTO chat_message_join VALUES (?, ?, ?)").run(chatId, rowid, date);
    };
    insert(10, 1, 1, 0); // number SMS
    insert(11, 3, 3, 1); // email SMS
    insert(12, 2, 2, 2); // number iMessage
    insert(13, 4, 4, 3); // email iMessage
    insert(14, 4, 4, 4); // email iMessage
    insert(15, 1, 1, 5); // number SMS
    insert(16, 2, 2, 6); // number iMessage
    insert(17, 3, 3, 7); // email SMS
    cd.close();

    return { chatDb, contactDbs, slugsDb };
  }

  async function exportCount(
    db: IMessageDB,
    identifier: string,
    outPath: string,
  ): Promise<{ count: number; ids: number[] }> {
    await streamExport({
      db,
      chatIdentifier: identifier,
      format: "ndjson",
      outputPath: outPath,
      since: null,
      until: null,
      pageSize: 100,
    });
    const ids = readFileSync(outPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { id: number }).id);
    return { count: ids.length, ids };
  }

  it("merges all four chats and exports the complete history from either handle", async () => {
    const { chatDb, contactDbs, slugsDb } = buildFixture({ withContactCard: true });
    const db = new IMessageDB(chatDb, contactDbs, slugsDb);
    const dir = tempDirs[tempDirs.length - 1];
    try {
      const fromPhone = await exportCount(db, phone, join(dir, "from-phone.ndjson"));
      expect(fromPhone.count).toBe(8);
      expect(new Set(fromPhone.ids).size).toBe(8);

      // Symmetry: exporting from the email handle yields the identical set.
      const fromEmail = await exportCount(db, email, join(dir, "from-email.ndjson"));
      expect(fromEmail.count).toBe(8);
      expect(new Set(fromEmail.ids)).toEqual(new Set(fromPhone.ids));

      // The hardened completeness diagnostic must NOT cry wolf on a correctly
      // merged identity (no false positives from the contactId-invariant signal).
      expect(db.findUnmergedSiblingChats(phone)).toEqual([]);
      expect(db.findUnmergedSiblingChats(email)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("gives the whole merged identity ONE stable slug across all four legs", async () => {
    const { chatDb, contactDbs, slugsDb } = buildFixture({ withContactCard: true });
    const db = new IMessageDB(chatDb, contactDbs, slugsDb);
    try {
      db.scheduleBackgroundSlugSync();
      await flush();

      const legs = [
        `SMS;-;${phone}`,
        `iMessage;-;${phone}`,
        `SMS;-;${email}`,
        `iMessage;-;${email}`,
      ];
      const slugs = legs.map((guid) => db.getSlugForChatGuid(guid));
      // Every leg resolves to a real slug, and they are all identical.
      for (const s of slugs) expect(looksLikeThreadSlug(s ?? undefined)).toBe(true);
      expect(new Set(slugs).size).toBe(1);

      // The canonical slug resolves back to the contact and merges everything.
      const slug = slugs[0] as string;
      const record = db.getSlugRecord(slug);
      expect(record).not.toBeNull();
      expect(record?.chatIdentifier).toBe(phone); // phone preferred as canonical handle
    } finally {
      await db.close();
    }
  });

  it("keeps slugs stable when Address Book load order renumbers contact ids", async () => {
    // Contact ids are ephemeral (assigned in load order). The slug hash must
    // key off the contact's stable handle anchor, so inserting an unrelated
    // card ahead of ours — which shifts every contactId — must NOT change the
    // slug (with self-heal, an id-keyed hash would churn every slug).
    const { chatDb, contactDbs, slugsDb } = buildFixture({ withContactCard: true });

    const db1 = new IMessageDB(chatDb, contactDbs, slugsDb);
    let firstSlug: string | null = null;
    try {
      db1.scheduleBackgroundSlugSync();
      await flush();
      firstSlug = db1.getSlugForChatGuid(`iMessage;-;${phone}`);
      expect(looksLikeThreadSlug(firstSlug ?? undefined)).toBe(true);
    } finally {
      await db1.close();
    }

    // Second session: an unrelated card now loads FIRST (new source DB path
    // sorts ahead), renumbering all contact ids.
    const dir = tempDirs[tempDirs.length - 1];
    const extraDb = join(dir, "AddressBook-v22-aaa-first.abcddb");
    makeAddressBook(extraDb, {
      firstName: "Aaron",
      lastName: "Aardvark",
      phone: "+15550000001",
    });

    const db2 = new IMessageDB(chatDb, [extraDb, ...contactDbs], slugsDb);
    try {
      db2.scheduleBackgroundSlugSync();
      await flush();
      expect(db2.getSlugForChatGuid(`iMessage;-;${phone}`)).toBe(firstSlug);
    } finally {
      await db2.close();
    }
  });

  it("self-heals a stale slug when the canonical slug for a guid changes", async () => {
    const { chatDb, contactDbs, slugsDb } = buildFixture({ withContactCard: true });

    // Seed the slug store with a WRONG slug for the phone's iMessage leg —
    // simulates a slug minted under an earlier bug (e.g. false contact union).
    const { SlugStore } = await import("../src/slug-store.js");
    const seed = new SlugStore(slugsDb);
    seed.upsert({
      slug: "wrong-name~imsg~dead",
      chatGuid: `iMessage;-;${phone}`,
      chatIdentifier: phone,
      displayName: "Wrong Name",
      service: "iMessage",
      isGroup: false,
      participants: phone,
      updatedAt: 1,
    });
    seed.close();

    const db = new IMessageDB(chatDb, contactDbs, slugsDb);
    try {
      db.scheduleBackgroundSlugSync();
      await flush();

      const healed = db.getSlugForChatGuid(`iMessage;-;${phone}`);
      expect(healed).not.toBe("wrong-name~imsg~dead");
      expect(looksLikeThreadSlug(healed ?? undefined)).toBe(true);
      // ...and it converges with every other leg of the identity.
      expect(db.getSlugForChatGuid(`SMS;-;${email}`)).toBe(healed);
      // The orphaned wrong slug row was pruned.
      expect(db.getSlugRecord("wrong-name~imsg~dead")).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("a background slug sync in flight stops cleanly when the DB is closed", async () => {
    const { chatDb, contactDbs, slugsDb } = buildFixture({ withContactCard: true });
    const db = new IMessageDB(chatDb, contactDbs, slugsDb);
    // Schedule the sync, then close before its first chunk runs. The guard must
    // make the queued chunk no-op instead of throwing "database is not open".
    db.scheduleBackgroundSlugSync();
    await db.close();
    await flush(); // let any queued setImmediate chunk fire
    // Reaching here without an uncaught exception is the assertion.
    expect(true).toBe(true);
  });

  it("documents the dependency: with no Address Book, the email leg is NOT merged", async () => {
    const { chatDb, contactDbs, slugsDb } = buildFixture({ withContactCard: false });
    const db = new IMessageDB(chatDb, contactDbs, slugsDb);
    const dir = tempDirs[tempDirs.length - 1];
    try {
      // Without a card, the merge key is identifier-based, so only the number's
      // own two chats (SMS + iMessage for +15550000099) fold together — the
      // email's two chats are a separate conversation. This is the exact gap
      // the completeness diagnostic exists to surface.
      const fromPhone = await exportCount(db, phone, join(dir, "no-card.ndjson"));
      expect(fromPhone.count).toBe(4);
    } finally {
      await db.close();
    }
  });
});

describe("findUnmergedSiblingChats", () => {
  it("flags a non-group chat that shares person_centric_id but was not merged", async () => {
    const dir = newDir();
    const chatDb = join(dir, "chat.db");
    const slugsDb = join(dir, "slugs.db");
    const phone = "+15551230000";
    const email = "sibling@example.com";

    const cd = createChatDb(chatDb);
    // Two handles Apple links via the same person_centric_id, but with no
    // Address Book entry their merge keys are identifier-based and differ —
    // so the two chats do NOT merge and the diagnostic should catch it.
    cd.prepare(
      "INSERT INTO handle (ROWID, id, service, person_centric_id) VALUES (1, ?, 'iMessage', 'PC-SHARED')",
    ).run(phone);
    cd.prepare(
      "INSERT INTO handle (ROWID, id, service, person_centric_id) VALUES (2, ?, 'iMessage', 'PC-SHARED')",
    ).run(email);
    cd.prepare(
      "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (1, ?, ?, 'iMessage', 45)",
    ).run(`iMessage;-;${phone}`, phone);
    cd.prepare(
      "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, style) VALUES (2, ?, ?, 'iMessage', 45)",
    ).run(`iMessage;-;${email}`, email);
    cd.prepare("INSERT INTO chat_handle_join VALUES (1, 1)").run();
    cd.prepare("INSERT INTO chat_handle_join VALUES (2, 2)").run();

    const base = Math.floor((Date.UTC(2025, 0, 1) / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
    cd.prepare(
      "INSERT INTO message (ROWID, guid, text, handle_id, date, is_read, is_delivered, service) VALUES (1, 'p1', 'hi phone', 1, ?, 1, 1, 'iMessage')",
    ).run(base);
    cd.prepare(
      "INSERT INTO message (ROWID, guid, text, handle_id, date, is_read, is_delivered, service) VALUES (2, 'e1', 'hi email', 2, ?, 1, 1, 'iMessage')",
    ).run(base + NANOS_PER_SECOND);
    cd.prepare("INSERT INTO chat_message_join VALUES (1, 1, ?)").run(base);
    cd.prepare("INSERT INTO chat_message_join VALUES (2, 2, ?)").run(base + NANOS_PER_SECOND);
    cd.close();

    const db = new IMessageDB(chatDb, [], slugsDb);
    try {
      const siblings = db.findUnmergedSiblingChats(phone);
      expect(siblings).toHaveLength(1);
      expect(siblings[0].chatIdentifier).toBe(email);

      // And symmetrically from the email side.
      const fromEmail = db.findUnmergedSiblingChats(email);
      expect(fromEmail.map((s) => s.chatIdentifier)).toContain(phone);
    } finally {
      await db.close();
    }
  });
});
