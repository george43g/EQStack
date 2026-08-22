/**
 * macOS Contacts Database Reader
 *
 * Loads contacts from all available sources:
 * - Local: ~/Library/Application Support/AddressBook/AddressBook-v22.abcddb
 * - iCloud / other accounts: ~/Library/Application Support/AddressBook/Sources/<UUID>/AddressBook-v22.abcddb
 *
 * Merges all into a single lookup so phone/email resolve to display names from any source.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ContactMatch, rankContacts } from "./contact-rank.js";
import { normalizeEmail, phoneDigits, phoneVariants } from "./handle-normal.js";
import Database, { type SqliteDatabase } from "./sqlite.js";

/** @deprecated Import `phoneVariants` from ./handle-normal.js instead. Kept as
 *  a named re-export so existing importers keep resolving. */
export { phoneVariants as normalizedPhoneVariants } from "./handle-normal.js";

export interface Contact {
  id: number;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  nickname: string | null;
  organization: string | null;
  displayName: string;
  phoneNumbers: string[];
  emails: string[];
}

export interface ContactLookup {
  contactId: number;
  displayName: string;
  label?: string;
}

/** Normalize a name for cross-card equivalence: lowercase, strip diacritics, collapse whitespace. */
function normalizeNameForMatch(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The set of normalized names a card can be known by (nickname, "first last",
 * organization). Two cards are considered the same entity when these sets
 * intersect — so a card nicknamed "Dad" still matches a "Armen Grigorian" card,
 * but an org card ("ProperyStart VR") sharing one utility email with a person
 * does NOT match them.
 */
function nameCandidates(fields: {
  firstName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  organization?: string | null;
}): Set<string> {
  const out = new Set<string>();
  const add = (n: string | null | undefined) => {
    const norm = normalizeNameForMatch(n);
    if (norm) out.add(norm);
  };
  add(fields.nickname);
  const full = [fields.firstName, fields.lastName].filter(Boolean).join(" ");
  add(full);
  add(fields.organization);
  return out;
}

const ADDRESS_BOOK_DIR = join(homedir(), "Library", "Application Support", "AddressBook");
const MAIN_DB_NAME = "AddressBook-v22.abcddb";

/**
 * Discover all Address Book database paths: main DB plus each source (e.g. iCloud).
 */
function discoverContactDbPaths(customPaths?: string | string[]): string[] {
  if (customPaths) {
    const list = Array.isArray(customPaths) ? customPaths : [customPaths];
    return list.filter((p) => existsSync(p));
  }

  const paths: string[] = [];
  const mainDb = join(ADDRESS_BOOK_DIR, MAIN_DB_NAME);
  if (existsSync(mainDb)) paths.push(mainDb);

  const sourcesDir = join(ADDRESS_BOOK_DIR, "Sources");
  if (existsSync(sourcesDir)) {
    try {
      const subdirs = readdirSync(sourcesDir, { withFileTypes: true });
      for (const d of subdirs) {
        if (!d.isDirectory()) continue;
        const sourceDb = join(sourcesDir, d.name, MAIN_DB_NAME);
        if (existsSync(sourceDb)) paths.push(sourceDb);
      }
    } catch {
      // ignore read errors
    }
  }

  return paths;
}

export class ContactsDB {
  private dbPaths: string[] = [];
  private databases: SqliteDatabase[] = [];
  private phoneMap: Map<string, ContactLookup> = new Map();
  private emailMap: Map<string, ContactLookup> = new Map();
  private contactCache: Map<number, Contact> = new Map();
  private initialized = false;
  /** Next id when loading from multiple DBs (avoids Z_PK collisions across sources). */
  private nextContactId = 1;

  constructor(dbPaths?: string | string[]) {
    this.dbPaths = discoverContactDbPaths(dbPaths);
  }

  /**
   * Initialize the contact lookup maps from all discovered DBs (local + iCloud/sources).
   */
  initialize(): void {
    if (this.initialized) return;

    for (const path of this.dbPaths) {
      try {
        const db = new Database(path, { readonly: true });
        this.databases.push(db);
        this.loadContactsFromDb(db);
      } catch (err) {
        console.warn(`ContactsDB: could not load ${path}:`, err);
      }
    }

    this.initialized = true;
  }

  /**
   * Load contacts from a single Address Book SQLite DB into the shared maps.
   */
  private loadContactsFromDb(db: SqliteDatabase): void {
    const contacts = db
      .prepare(`
      SELECT 
        Z_PK as localId,
        ZFIRSTNAME as firstName,
        ZLASTNAME as lastName,
        ZMIDDLENAME as middleName,
        ZNICKNAME as nickname,
        ZORGANIZATION as organization
      FROM ZABCDRECORD
      WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL
    `)
      .all() as any[];

    for (const row of contacts) {
      const localId = row.localId as number;

      const phones = (
        db
          .prepare(`
        SELECT ZFULLNUMBER as number, ZLABEL as label
        FROM ZABCDPHONENUMBER
        WHERE ZOWNER = ? OR Z22_OWNER = ?
      `)
          .all(localId, localId) as any[]
      ).filter((p) => p.number);

      const emails = (
        db
          .prepare(`
        SELECT ZADDRESS as email, ZLABEL as label
        FROM ZABCDEMAILADDRESS
        WHERE ZOWNER = ? OR Z22_OWNER = ?
      `)
          .all(localId, localId) as any[]
      ).filter((e) => e.email);

      // Cross-source dedup + union: if a handle already resolves to a contact
      // loaded from an earlier source DB AND the two cards plausibly name the
      // same entity, reuse that contact instead of minting a new id — that's
      // how a person split across a local card (phone) and an iCloud card
      // (email) merges into one identity.
      //
      // The name gate matters: distinct cards can legitimately share a handle
      // (a person's card and their business's org card both carrying the same
      // info@ email). Unioning those folds two different entities into one
      // contactId — mislabeling conversations and wrongly merging threads. So
      // union only when the cards' name-candidate sets intersect; otherwise
      // mint a separate contact and leave the shared handle with its first
      // claimant (Messages.app behaves the same way).
      const existingIds = this.findExistingContactIds(
        phones.map((p) => p.number as string),
        emails.map((e) => e.email as string),
      );
      const cardNames = nameCandidates(row);
      const sameEntityIds = existingIds.filter((id) => {
        const existing = this.contactCache.get(id);
        if (!existing) return false;
        const existingNames = nameCandidates(existing);
        // A card with no usable name can't be disproven — treat as a match.
        if (cardNames.size === 0 || existingNames.size === 0) return true;
        for (const n of cardNames) if (existingNames.has(n)) return true;
        return false;
      });

      let contact: Contact;
      if (sameEntityIds.length === 0) {
        contact = {
          id: this.nextContactId++,
          firstName: row.firstName,
          lastName: row.lastName,
          middleName: row.middleName,
          nickname: row.nickname,
          organization: row.organization,
          displayName: this.buildDisplayName(row),
          phoneNumbers: [],
          emails: [],
        };
      } else {
        const survivorId = sameEntityIds[0];
        for (let i = 1; i < sameEntityIds.length; i++) {
          this.mergeContacts(survivorId, sameEntityIds[i]);
        }
        contact = this.contactCache.get(survivorId) as Contact;
      }

      // Register handles with the DECLARING card's name (nickname-first), not
      // the survivor's — a handle is named by the card that carries it, exactly
      // like Messages.app. First claimant wins for a handle two cards share.
      const handleName = this.buildDisplayName(row);

      for (const phone of phones) {
        if (!contact.phoneNumbers.includes(phone.number)) contact.phoneNumbers.push(phone.number);
        for (const variant of phoneVariants(phone.number)) {
          if (!this.phoneMap.has(variant)) {
            this.phoneMap.set(variant, {
              contactId: contact.id,
              displayName: handleName,
              label: phone.label,
            });
          }
        }
      }

      for (const email of emails) {
        if (!contact.emails.includes(email.email)) contact.emails.push(email.email);
        const key = normalizeEmail(email.email);
        if (!this.emailMap.has(key)) {
          this.emailMap.set(key, {
            contactId: contact.id,
            displayName: handleName,
            label: email.label,
          });
        }
      }

      this.contactCache.set(contact.id, contact);
    }
  }

  /**
   * Probe the already-loaded lookup maps for every existing contactId that
   * shares any of these handles (loaded from earlier source DBs). Returns the
   * distinct ids in first-seen order; the caller treats the first as the
   * survivor and unions the rest. Empty when none match.
   */
  private findExistingContactIds(phones: string[], emails: string[]): number[] {
    const ids: number[] = [];
    const seen = new Set<number>();
    const add = (id: number) => {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    };
    for (const number of phones) {
      for (const variant of phoneVariants(number)) {
        const hit = this.phoneMap.get(variant);
        if (hit) add(hit.contactId);
      }
    }
    for (const email of emails) {
      const hit = this.emailMap.get(normalizeEmail(email));
      if (hit) add(hit.contactId);
    }
    return ids;
  }

  /**
   * Fold contact `dropId` into `keepId`: union their phone/email lists and
   * re-point every lookup-map entry (preserving labels) from the dropped id to
   * the survivor, then forget the dropped id. Used when one card bridges two
   * previously-separate identities.
   */
  private mergeContacts(keepId: number, dropId: number): void {
    if (keepId === dropId) return;
    const keep = this.contactCache.get(keepId);
    const drop = this.contactCache.get(dropId);
    if (!keep || !drop) return;

    for (const p of drop.phoneNumbers)
      if (!keep.phoneNumbers.includes(p)) keep.phoneNumbers.push(p);
    for (const e of drop.emails) if (!keep.emails.includes(e)) keep.emails.push(e);

    // Repoint the dropped id but keep each entry's per-handle displayName —
    // the declaring card's name stays authoritative for its own handles.
    for (const [key, lookup] of this.phoneMap) {
      if (lookup.contactId === dropId) {
        this.phoneMap.set(key, { ...lookup, contactId: keepId });
      }
    }
    for (const [key, lookup] of this.emailMap) {
      if (lookup.contactId === dropId) {
        this.emailMap.set(key, { ...lookup, contactId: keepId });
      }
    }
    this.contactCache.delete(dropId);
  }

  /**
   * Look up a contact by phone number or email.
   */
  lookupContact(handle: string): ContactLookup | null {
    if (!this.initialized) {
      this.initialize();
    }

    if (/[\d+\-()\s]/.test(handle)) {
      for (const variant of phoneVariants(handle)) {
        const contact = this.phoneMap.get(variant);
        if (contact) {
          return contact;
        }
      }
    }

    if (handle.includes("@")) {
      const normalized = normalizeEmail(handle);
      const contact = this.emailMap.get(normalized);
      if (contact) {
        return contact;
      }
    }

    return null;
  }

  /**
   * Look up a contact by phone number or email
   * Returns display name if found, or the original handle if not
   */
  lookupHandle(handle: string): string {
    return this.lookupContact(handle)?.displayName ?? handle;
  }

  /**
   * Get full contact details by ID
   */
  getContact(id: number): Contact | null {
    if (!this.initialized) {
      this.initialize();
    }
    return this.contactCache.get(id) || null;
  }

  /**
   * A load-order-independent identity anchor for a contact: the
   * lexicographically smallest normalized handle. Contact ids are assigned in
   * Address Book load order, so they renumber whenever any card is added or
   * removed — anything persisted across sessions (thread-slug hashes) must key
   * off this anchor instead, which only changes if the contact's own handles
   * change.
   */
  stableAnchor(contactId: number): string | null {
    const contact = this.getContact(contactId);
    if (!contact) return null;
    const handles = [
      ...contact.phoneNumbers.map((p) => phoneDigits(p)),
      ...contact.emails.map((e) => normalizeEmail(e)),
    ].filter((h) => h.length > 0);
    if (handles.length === 0) return null;
    handles.sort();
    return handles[0];
  }

  /**
   * Search contacts by name
   */
  searchContacts(query: string): Contact[] {
    if (!this.initialized) {
      this.initialize();
    }

    const lowerQuery = query.toLowerCase();
    return Array.from(this.contactCache.values()).filter(
      (c) =>
        c.displayName.toLowerCase().includes(lowerQuery) ||
        c.phoneNumbers.some((p) => p.includes(query)) ||
        c.emails.some((e) => e.toLowerCase().includes(lowerQuery)),
    );
  }

  /**
   * Search contacts, ranked by relevance with the matched field annotated.
   * Preserves the substring recall of searchContacts (a substring match scores
   * 0.7, above the inclusion floor) while ordering best-first so callers can
   * disambiguate close matches instead of eyeballing an unordered list.
   */
  searchContactsRanked(query: string): ContactMatch[] {
    if (!this.initialized) {
      this.initialize();
    }
    return rankContacts(query, Array.from(this.contactCache.values()));
  }

  /**
   * Build display name from contact fields
   */
  private buildDisplayName(row: any): string {
    if (row.nickname) return row.nickname;

    const parts: string[] = [];

    if (row.firstName) parts.push(row.firstName);
    if (row.lastName) parts.push(row.lastName);

    if (parts.length > 0) {
      return parts.join(" ");
    }

    if (row.organization) return row.organization;

    return "Unknown Contact";
  }

  /**
   * Close all database connections
   */
  close(): void {
    for (const db of this.databases) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    this.databases = [];
  }

  /**
   * Paginated list of all loaded contacts, sorted by displayName.
   * Used by the MCP `list_contacts` tool.
   */
  listContacts(offset = 0, limit = 20): { contacts: Contact[]; total: number } {
    if (!this.initialized) {
      this.initialize();
    }
    const all = Array.from(this.contactCache.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
    const slice = limit === 0 ? all.slice(offset) : all.slice(offset, offset + limit);
    return { contacts: slice, total: all.length };
  }

  /**
   * Get statistics about loaded contacts
   */
  getStats() {
    if (!this.initialized) {
      this.initialize();
    }

    return {
      totalContacts: this.contactCache.size,
      phoneNumbers: this.phoneMap.size,
      emails: this.emailMap.size,
    };
  }
}
