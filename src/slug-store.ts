/**
 * Persistent SQLite store for conversation thread slugs.
 * Stores slug-to-chat mappings at ~/.imsg-mcp/slugs.db so they survive
 * MCP server restarts and can be referenced by agents/scripts.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database, { type SqliteDatabase } from "./sqlite.js";

export interface SlugRecord {
  slug: string;
  chatGuid: string;
  chatIdentifier: string;
  displayName: string | null;
  service: string;
  isGroup: boolean;
  participants: string;
  updatedAt: number;
}

const DEFAULT_DIR = join(homedir(), ".imsg-mcp");
const DEFAULT_DB = join(DEFAULT_DIR, "slugs.db");

export class SlugStore {
  private db: SqliteDatabase;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  /**
   * Schema. v2 splits identity-level slug rows from a many-to-one guid map so a
   * single canonical slug can cover every chat leg of one contact (phone + email,
   * SMS + iMessage). v1 keyed a slug to exactly one guid, so a merged identity
   * produced multiple slugs whose surfaced one flipped with recency.
   */
  private migrate(): void {
    const version = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (version < 2) {
      // v1 slugs hashed the per-chat guid, so they are stale under the v2
      // identity hash. Slugs are derived data (rebuilt by the next sync), so we
      // drop and recreate rather than attempt an in-place value migration.
      this.db.exec("DROP TABLE IF EXISTS thread_slugs");
      this.db.exec("DROP TABLE IF EXISTS slug_chat_guids");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_slugs (
        slug            TEXT PRIMARY KEY,
        chat_identifier TEXT NOT NULL,
        display_name    TEXT,
        service         TEXT NOT NULL DEFAULT 'iMessage',
        is_group        INTEGER NOT NULL DEFAULT 0,
        participants    TEXT NOT NULL DEFAULT '',
        updated_at      INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS slug_chat_guids (
        chat_guid TEXT PRIMARY KEY,
        slug      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_slug_chat_guids_slug ON slug_chat_guids(slug);
    `);
    this.db.pragma("user_version = 2");
  }

  /**
   * Upsert one chat leg under its identity slug. The identity row is keyed by
   * slug (idempotent across legs); the leg's guid is mapped to that slug. When
   * an identity already has a phone `chat_identifier`, a later email leg does
   * NOT overwrite it — phone is preferred as the canonical handle for stability.
   */
  upsert(record: SlugRecord): void {
    const params = {
      slug: record.slug,
      chatGuid: record.chatGuid,
      chatIdentifier: record.chatIdentifier,
      displayName: record.displayName,
      service: record.service,
      isGroup: record.isGroup ? 1 : 0,
      participants: record.participants,
      updatedAt: record.updatedAt,
    };

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO thread_slugs (slug, chat_identifier, display_name, service, is_group, participants, updated_at)
          VALUES (@slug, @chatIdentifier, @displayName, @service, @isGroup, @participants, @updatedAt)
          ON CONFLICT(slug) DO UPDATE SET
            chat_identifier = CASE
              WHEN instr(thread_slugs.chat_identifier, '@') = 0 AND instr(excluded.chat_identifier, '@') > 0
                THEN thread_slugs.chat_identifier
              ELSE excluded.chat_identifier
            END,
            display_name = excluded.display_name,
            service = excluded.service,
            is_group = excluded.is_group,
            participants = excluded.participants,
            updated_at = excluded.updated_at
        `)
        .run(params);

      this.db
        .prepare(`
          INSERT INTO slug_chat_guids (chat_guid, slug) VALUES (@chatGuid, @slug)
          ON CONFLICT(chat_guid) DO UPDATE SET slug = excluded.slug
        `)
        .run(params);
    });
    tx();
  }

  upsertMany(records: SlugRecord[]): void {
    const tx = this.db.transaction((recs: SlugRecord[]) => {
      for (const r of recs) this.upsert(r);
    });
    tx(records);
  }

  lookupBySlug(slug: string): SlugRecord | null {
    const row = this.db.prepare("SELECT * FROM thread_slugs WHERE slug = ?").get(slug) as any;
    return row ? this.rowToRecord(row, this.representativeGuid(slug)) : null;
  }

  lookupByGuid(chatGuid: string): SlugRecord | null {
    const link = this.db
      .prepare("SELECT slug FROM slug_chat_guids WHERE chat_guid = ?")
      .get(chatGuid) as { slug: string } | undefined;
    if (!link) return null;
    const row = this.db.prepare("SELECT * FROM thread_slugs WHERE slug = ?").get(link.slug) as any;
    // Return the queried guid as the representative — it's the one the caller has.
    return row ? this.rowToRecord(row, chatGuid) : null;
  }

  lookupByChatIdentifier(chatIdentifier: string): SlugRecord | null {
    const row = this.db
      .prepare("SELECT * FROM thread_slugs WHERE chat_identifier = ?")
      .get(chatIdentifier) as any;
    return row ? this.rowToRecord(row, this.representativeGuid(row.slug)) : null;
  }

  all(): SlugRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM thread_slugs ORDER BY updated_at DESC")
      .all() as any[];
    return rows.map((r) => this.rowToRecord(r, this.representativeGuid(r.slug)));
  }

  /** Every guid→slug link (used to rebuild the in-memory guid map on startup). */
  guidLinks(): { chatGuid: string; slug: string }[] {
    const rows = this.db.prepare("SELECT chat_guid, slug FROM slug_chat_guids").all() as {
      chat_guid: string;
      slug: string;
    }[];
    return rows.map((r) => ({ chatGuid: r.chat_guid, slug: r.slug }));
  }

  /** A stable representative guid for a slug (lowest guid, or "" if none). */
  private representativeGuid(slug: string): string {
    const row = this.db
      .prepare("SELECT MIN(chat_guid) as guid FROM slug_chat_guids WHERE slug = ?")
      .get(slug) as { guid: string | null } | undefined;
    return row?.guid ?? "";
  }

  /**
   * Drop guid links whose chat_guid is not in the valid set, then any identity
   * slug left with no guids. Returns the number of guid links removed.
   */
  prune(validGuids: Set<string>): number {
    const links = this.db.prepare("SELECT chat_guid FROM slug_chat_guids").all() as {
      chat_guid: string;
    }[];
    const toDelete = links.filter((r) => !validGuids.has(r.chat_guid)).map((r) => r.chat_guid);
    const tx = this.db.transaction(() => {
      const delLink = this.db.prepare("DELETE FROM slug_chat_guids WHERE chat_guid = ?");
      for (const guid of toDelete) delLink.run(guid);
      this.db.exec(
        "DELETE FROM thread_slugs WHERE slug NOT IN (SELECT DISTINCT slug FROM slug_chat_guids)",
      );
    });
    tx();
    return toDelete.length;
  }

  close(): void {
    this.db.close();
  }

  private rowToRecord(row: any, chatGuid: string): SlugRecord {
    return {
      slug: row.slug,
      chatGuid,
      chatIdentifier: row.chat_identifier,
      displayName: row.display_name,
      service: row.service,
      isGroup: Boolean(row.is_group),
      participants: row.participants,
      updatedAt: row.updated_at,
    };
  }
}
