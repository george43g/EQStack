/**
 * iMessage Database Reader
 *
 * All database access goes through a single better-sqlite3 connection.
 * attributedBody parsing uses our local TypedStreamParser fork.
 *
 * See docs/IMESSAGE_DB_SCHEMA.md for database structure reference.
 * Schema constants and epoch/timestamp helpers live in db-schema.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/** Minimal chat row from the chat table. */
export interface ChatRow {
  ROWID: number;
  guid: string;
  chat_identifier: string;
  display_name: string | null;
}

/** Raw message row from the message table (columns used throughout this module). */
export interface MessageRow {
  ROWID: number;
  guid: string;
  text: string | null;
  attributedBody: Buffer | null;
  date: number;
  is_from_me: number;
  handle_id: string | null;
  cache_has_attachments: number;
}

export interface MessageExportCursor {
  date: number;
  rowid: number;
}

export interface MessageExportPage {
  messages: Message[];
  nextCursor: MessageExportCursor | null;
  rawCount: number;
}

/** A chat that appears to be the same person as the exported conversation but was not merged into it. */
export interface UnmergedSiblingChat {
  chatIdentifier: string;
  reason: string;
}

import { extractAttributedBodyText, extractAudioTranscription } from "./attributed-body-text.js";
import { ContactsDB } from "./contacts-db.js";
import { mergeDuplicateConversations } from "./conversation-merge.js";
import {
  isMetadataOnlySnippet,
  normalizeRichMetadataText,
  pickConversationSnippet,
} from "./conversation-snippet.js";
import {
  AssociatedMessageType,
  isReactionType,
  MAC_EPOCH_OFFSET,
  macAutoTimestampToDate,
  NANOS_PER_SECOND,
  OBJECT_REPLACEMENT_CHAR,
  macTimestampToDate as schemaMacTimestampToDate,
  parseAssociatedMessageGuid as schemaParseAssociatedMessageGuid,
  Tables,
} from "./db-schema.js";
import { extractEditHistory } from "./edit-history.js";
import { fuzzyScore } from "./fuzzy.js";
import { perf } from "./logger.js";
import { extractChatSummaryText, isUnsentMessage } from "./plist-text.js";
import { type SlugRecord, SlugStore } from "./slug-store.js";
import { generateThreadSlug, isGroupChatIdentifier, isGroupGuid } from "./thread-slug.js";
import type {
  Attachment,
  Conversation,
  ConversationAttachment,
  Message,
  Reaction,
  ReplyContext,
  ResolvedConversation,
  RichContentType,
  TapbackType,
} from "./types.js";

/** Chat row with last message date and service from join (for sorting by activity). */
type ChatWithLastDate = ChatRow & { last_date: number | null; service_name?: string | null };
type LastConversationRow = {
  chatId: number;
  lastDate: number;
  lastMessageId: number;
  lastService: string | null;
  lastIsFromMe: boolean;
  balloonBundleId: string | null;
  snippet: string | null;
  chatProperties: Buffer | null;
};
function toChatRow(c: ChatWithLastDate): ChatRow {
  return {
    ROWID: c.ROWID,
    guid: c.guid,
    chat_identifier: c.chat_identifier,
    display_name: c.display_name,
  };
}

/**
 * Tapback type codes from iMessage database
 * 2000-2005: Add reaction, 3000-3005: Remove reaction
 */
const TAPBACK_TYPE_MAP: Record<number, { type: TapbackType; isRemoval: boolean }> = {
  2000: { type: "love", isRemoval: false },
  2001: { type: "like", isRemoval: false },
  2002: { type: "dislike", isRemoval: false },
  2003: { type: "laugh", isRemoval: false },
  2004: { type: "emphasize", isRemoval: false },
  2005: { type: "question", isRemoval: false },
  2006: { type: "emoji", isRemoval: false }, // iOS 18+ custom emoji
  3000: { type: "love", isRemoval: true },
  3001: { type: "like", isRemoval: true },
  3002: { type: "dislike", isRemoval: true },
  3003: { type: "laugh", isRemoval: true },
  3004: { type: "emphasize", isRemoval: true },
  3005: { type: "question", isRemoval: true },
  3006: { type: "emoji", isRemoval: true },
  1000: { type: "sticker", isRemoval: false },
};

/** Use schema helper for parsing associated_message_guid. */
const parseAssociatedMessageGuid = schemaParseAssociatedMessageGuid;

function isPlaceholderText(text: string | null | undefined): boolean {
  if (!text) return true;
  return /^[\uFFFC\uFFFD\s]+$/u.test(text);
}

function isHiddenSystemItem(itemType: number | null | undefined): boolean {
  return (itemType ?? 0) !== 0;
}

/**
 * Determine rich content type from balloon_bundle_id
 */
function getRichContentType(balloonBundleId: string | null): RichContentType | undefined {
  if (!balloonBundleId) return undefined;

  if (balloonBundleId === "com.apple.messages.URLBalloonProvider") {
    return "link_preview";
  }
  if (balloonBundleId === "com.apple.DigitalTouchBalloonProvider") {
    return "digital_touch";
  }
  if (balloonBundleId === "com.apple.Handwriting.HandwritingProvider") {
    return "handwriting";
  }
  if (balloonBundleId.includes("findmy") || balloonBundleId.includes("Maps")) {
    return "location";
  }
  if (balloonBundleId.includes("MSMessageExtensionBalloonPlugin")) {
    return "app_message";
  }
  return "unknown";
}

/** Use schema helper for Mac epoch timestamps. */
const macTimestampToDate = schemaMacTimestampToDate;

function dateToMacTimestamp(date: Date): number {
  return Math.floor((date.getTime() / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
}

export class IMessageDB {
  private raw: Database.Database;
  private dbPath: string;
  /** Address-book reader. Public so MCP `*_contacts` tools can wrap it. */
  readonly contacts: ContactsDB;
  private slugStore: SlugStore;
  /** In-memory slug -> ChatWithLastDate for fast lookups during a session. */
  private slugMap = new Map<string, ChatWithLastDate>();
  /** In-memory chat guid -> slug for stable per-chat slug lookups. */
  private guidToSlug = new Map<string, string>();
  /** Per-sync canonical service per identity key (prefer iMessage) for slugs. */
  private identityServiceMap: Map<string, "iMessage" | "SMS"> | null = null;

  // ── TTL caches ───────────────────────────────────────────────────────
  private static readonly CACHE_TTL_MS = 30_000;
  private cachedAllChats: { data: ChatWithLastDate[]; ts: number } | null = null;
  private cachedLastByChat: { data: Record<number, LastConversationRow>; ts: number } | null = null;
  private cachedUnreadByChat: { data: Record<number, number>; ts: number } | null = null;
  private cachedParticipants = new Map<number, string[]>();
  private cachedMergeKeys = new Map<string, string>();
  private cachedSnippets = new Map<number, string | null>();
  /**
   * Per-chat reaction map (guid → reactions), TTL-cached. A large export pages
   * the same merged chats dozens of times; without this, every page re-scanned
   * each chat's full reaction set — O(pages × chats) — which dominated big
   * exports and spiked event-loop lag.
   *
   * Invalidation contract: entries expire via their per-entry TTL on read, and
   * the whole map is cleared only in scheduleBackgroundRefresh() — every read
   * path that can observe new messages schedules that refresh, so there is no
   * other clear site. Add one if you introduce a read path that bypasses it.
   */
  private cachedReactionsByChat = new Map<number, { data: Map<string, Reaction[]>; ts: number }>();
  /** Per-table column-name sets, for optional-column guards (schema drift / synthetic fixtures). */
  private columnCache = new Map<string, Set<string>>();
  private backgroundSyncNeeded = true;
  private backgroundRefreshScheduled = false;
  /** Set on close() so background chunked work stops touching a closed DB. */
  private closed = false;

  constructor(dbPath?: string, contactsDbPaths?: string | string[], slugStorePath?: string) {
    const span = perf("IMessageDB.constructor");
    this.dbPath = dbPath || join(homedir(), "Library", "Messages", "chat.db");
    this.raw = new Database(this.dbPath, { readonly: true });
    this.contacts = new ContactsDB(contactsDbPaths);
    this.slugStore = new SlugStore(slugStorePath);

    const contactsSpan = perf("contacts.initialize");
    try {
      this.contacts.initialize();
      contactsSpan.end();
    } catch (err) {
      contactsSpan.end({ error: String(err) });
      console.warn("Failed to initialize contacts database:", err);
    }

    this.loadCachedSlugs();
    span.end();
  }

  /**
   * Fast startup: load persisted slugs from SlugStore into in-memory maps.
   * No chat.db queries -- uses the SQLite slug store populated by previous runs.
   */
  private loadCachedSlugs(): void {
    const span = perf("loadCachedSlugs");
    // One slug can cover many chat legs — map every guid to its slug.
    for (const link of this.slugStore.guidLinks()) {
      this.guidToSlug.set(link.chatGuid, link.slug);
    }
    const records = this.slugStore.all();
    for (const r of records) {
      this.slugMap.set(r.slug, {
        ROWID: 0, // placeholder -- will be filled on full sync
        guid: r.chatGuid,
        chat_identifier: r.chatIdentifier,
        display_name: r.displayName,
        service_name: r.service ?? null,
        last_date: null,
      });
    }
    span.end({ loaded: records.length });
  }

  /**
   * Compute the canonical slug for a chat without persisting anything.
   *
   * Identity key: every chat leg of one contact (phone + email, SMS +
   * iMessage) shares this, so they collapse to ONE stable slug. Groups stay
   * per-guid. Mirrors getConversationMergeKey so the slug tracks the merge.
   * The service segment is identity-wide (prefer iMessage) — otherwise the
   * SMS leg and iMessage leg of one contact would produce `…~sms~h` and
   * `…~imsg~h`, i.e. two slugs.
   */
  private computeSlugForChat(chat: ChatWithLastDate): {
    slug: string;
    isGroup: boolean;
    resolvedName: string | null;
    canonicalService: "iMessage" | "SMS";
  } {
    const isGroup = isGroupGuid(chat.guid) || isGroupChatIdentifier(chat.chat_identifier);

    // Merge key groups legs within a session; the service map is keyed on it.
    const mergeKey = isGroup
      ? `group:${chat.guid}`
      : this.getConversationMergeKey(chat.chat_identifier, chat.guid, false);

    const canonicalService = isGroup
      ? this.detectServiceForChat(chat)
      : (this.identityServiceMap?.get(mergeKey) ?? this.detectServiceForChat(chat));

    // The persisted slug hash must NOT embed the session contactId (ids are
    // assigned in Address Book load order and renumber when any card changes).
    // Anchor on the contact's smallest normalized handle instead, and use the
    // identity-level (contact card) name so every leg of a union produces the
    // same name part even when per-handle display names differ.
    let identityKey = mergeKey;
    let resolvedName: string | null = null;
    if (!isGroup && chat.chat_identifier) {
      const lookup = this.contacts.lookupContact(chat.chat_identifier);
      if (lookup) {
        const anchor = this.contacts.stableAnchor(lookup.contactId);
        if (anchor) identityKey = `contact:${anchor}`;
        resolvedName =
          this.contacts.getContact(lookup.contactId)?.displayName ?? lookup.displayName;
      } else {
        const fallback = this.contacts.lookupHandle(chat.chat_identifier);
        resolvedName = fallback !== chat.chat_identifier ? fallback : null;
      }
    }

    const slug = generateThreadSlug({
      chatIdentifier: chat.chat_identifier,
      guid: chat.guid,
      displayName: chat.display_name,
      serviceName: canonicalService,
      resolvedContactName: resolvedName,
      identityKey,
    });
    return { slug, isGroup, resolvedName, canonicalService };
  }

  /**
   * Build the per-identity canonical service map (prefer iMessage) if absent.
   * The background sync populates this eagerly; this lets the cold synchronous
   * slug path build it on demand. Cheap: one pass over the cached chat list.
   */
  private ensureIdentityServiceMap(): void {
    if (this.identityServiceMap) return;
    const identityService = new Map<string, "iMessage" | "SMS">();
    for (const c of this.getAllChatsWithLastDate()) {
      if (isGroupGuid(c.guid) || isGroupChatIdentifier(c.chat_identifier)) continue;
      const key = this.getConversationMergeKey(c.chat_identifier, c.guid, false);
      const svc = this.detectServiceForChat(c);
      if (svc === "iMessage" || !identityService.has(key)) identityService.set(key, svc);
    }
    this.identityServiceMap = identityService;
  }

  /** Generate and cache a slug for a single chat. */
  private syncSlugForChat(chat: ChatWithLastDate): string {
    // Canonical per-identity service must be known before hashing, or the SMS
    // leg and iMessage leg of one contact would produce two different slugs.
    // The background sync sets this up front; on the cold synchronous path
    // (listConversations / findChatByHandle) we build it here on first use.
    this.ensureIdentityServiceMap();
    const { slug, isGroup, resolvedName, canonicalService } = this.computeSlugForChat(chat);

    const participants = isGroup ? this.fetchChatParticipants(chat.ROWID) : [chat.chat_identifier];

    this.slugStore.upsert({
      slug,
      chatGuid: chat.guid,
      chatIdentifier: chat.chat_identifier,
      displayName: resolvedName ?? chat.display_name ?? null,
      service: canonicalService,
      isGroup,
      participants: participants.join(","),
      updatedAt: Date.now(),
    });

    this.slugMap.set(slug, chat);
    this.guidToSlug.set(chat.guid, slug);
    return slug;
  }

  /**
   * Schedule a full slug sync in the background using setImmediate chunks.
   * Each chunk processes up to 100 chats then yields the event loop.
   */
  scheduleBackgroundSlugSync(): void {
    if (!this.backgroundSyncNeeded) return;
    this.backgroundSyncNeeded = false;

    const span = perf("backgroundSlugSync");
    const chats = this.getAllChatsWithLastDate();

    // Precompute one canonical service per identity (prefer iMessage) so every
    // leg of a contact hashes into the SAME slug regardless of SMS/iMessage.
    const identityService = new Map<string, "iMessage" | "SMS">();
    for (const c of chats) {
      if (isGroupGuid(c.guid) || isGroupChatIdentifier(c.chat_identifier)) continue;
      const key = this.getConversationMergeKey(c.chat_identifier, c.guid, false);
      const svc = this.detectServiceForChat(c);
      if (svc === "iMessage" || !identityService.has(key)) identityService.set(key, svc);
    }
    this.identityServiceMap = identityService;

    const validGuids = new Set<string>();
    let index = 0;
    let synced = 0;
    const CHUNK = 100;

    const processChunk = () => {
      if (this.closed) return; // DB closed mid-sync (e.g. shutdown) — stop cleanly.
      const end = Math.min(index + CHUNK, chats.length);
      for (; index < end; index++) {
        const chat = chats[index];
        validGuids.add(chat.guid);
        // Self-heal: re-sync not only unknown guids but any guid whose expected
        // canonical slug changed (contact data or merge policy changed since it
        // was stored — e.g. a false contact union corrected). The store's
        // guid→slug upsert remaps the leg; prune sweeps orphaned slug rows.
        const expected = this.computeSlugForChat(chat).slug;
        if (this.guidToSlug.get(chat.guid) !== expected) {
          this.syncSlugForChat(chat);
          synced++;
        } else {
          // Update the in-memory map with fresh data (ROWID, last_date)
          this.slugMap.set(expected, chat);
        }
      }
      if (index < chats.length) {
        setImmediate(processChunk);
      } else {
        this.slugStore.prune(validGuids);
        span.end({ chats: chats.length, newSlugs: synced });
      }
    };

    setImmediate(processChunk);
  }

  /** Look up a chat by thread slug. */
  findChatBySlug(slug: string): ChatRow | null {
    const cached = this.slugMap.get(slug);
    if (cached) return toChatRow(cached);
    const record = this.slugStore.lookupBySlug(slug);
    if (!record) return null;
    return this.findChatByIdentifier(record.chatIdentifier);
  }

  /** Get the slug for a specific chat GUID. */
  getSlugForChatGuid(chatGuid: string): string | null {
    const cached = this.guidToSlug.get(chatGuid);
    if (cached) return cached;
    const record = this.slugStore.lookupByGuid(chatGuid);
    return record?.slug ?? null;
  }

  /** Get the slug record for a chat_identifier (for attaching to output). */
  getSlugForChatIdentifier(chatIdentifier: string): string | null {
    const matches = [...this.slugMap.entries()].filter(
      ([, chat]) => chat.chat_identifier === chatIdentifier,
    );
    if (matches.length === 1) return matches[0][0];
    if (matches.length > 1) return null;
    const record = this.slugStore.lookupByChatIdentifier(chatIdentifier);
    return record?.slug ?? null;
  }

  /** Get slug record by slug string. */
  getSlugRecord(slug: string): SlugRecord | null {
    return this.slugStore.lookupBySlug(slug);
  }

  /** Get all slug records. */
  getAllSlugs(): SlugRecord[] {
    return this.slugStore.all();
  }

  /** Fetch group chat participants from chat_handle_join. */
  private fetchChatParticipants(chatRowId: number): string[] {
    const cached = this.cachedParticipants.get(chatRowId);
    if (cached) return cached;
    const stmt = this.raw.prepare(`
      SELECT h.id
      FROM ${Tables.CHAT_HANDLE_JOIN} chj
      JOIN ${Tables.HANDLE} h ON chj.handle_id = h.ROWID
      WHERE chj.chat_id = ?
    `);
    const rows = stmt.all(chatRowId) as { id: string }[];
    const result = rows.map((r) => r.id);
    this.cachedParticipants.set(chatRowId, result);
    return result;
  }

  /** Detect service type from chat data. */
  private detectServiceForChat(chat: ChatWithLastDate): "iMessage" | "SMS" {
    if (chat.service_name) {
      return chat.service_name.toLowerCase().includes("sms") ? "SMS" : "iMessage";
    }
    if (chat.guid) {
      return chat.guid.toLowerCase().startsWith("sms") ? "SMS" : "iMessage";
    }
    return "iMessage";
  }

  /**
   * Identity-canonical service for a conversation's badge (prefer iMessage).
   * Unlike detectServiceForChat (one leg's service), this reflects the whole
   * identity: if ANY leg is iMessage the thread is iMessage. It matches the
   * ~imsg~/~sms~ slug segment (computeSlugForChat) and the slug-store send
   * route, so the badge can't disagree with them. Without this, a single newer
   * SMS leg of a fundamentally-iMessage thread wins the merge cascade and flips
   * the badge to "SMS" while the slug stays ~imsg~. Groups have no cross-service
   * identity, so fall back to the chat's own service.
   */
  private canonicalServiceForChat(chat: ChatWithLastDate): "iMessage" | "SMS" {
    if (isGroupGuid(chat.guid) || isGroupChatIdentifier(chat.chat_identifier)) {
      return this.detectServiceForChat(chat);
    }
    this.ensureIdentityServiceMap();
    const mergeKey = this.getConversationMergeKey(chat.chat_identifier, chat.guid, false);
    return this.identityServiceMap?.get(mergeKey) ?? this.detectServiceForChat(chat);
  }

  /**
   * Get the N most recent messages across all conversations
   * By default excludes reactions (tapbacks) for cleaner output
   */
  async getRecentMessages(
    limit: number = 20,
    includeReactions: boolean = false,
  ): Promise<Message[]> {
    const span = perf("getRecentMessages");
    const chats = this.getAllChatsWithLastDate()
      .sort((a, b) => (b.last_date ?? 0) - (a.last_date ?? 0))
      .slice(0, 10);

    const allMessages: Message[] = [];

    for (const chat of chats) {
      try {
        const rows = this.fetchMessagesForChatRowId(chat.ROWID, Math.min(limit * 2, 40));
        const extBatch = this.fetchExtendedMessageDataBatch(rows.map((r) => r.ROWID));

        for (const msg of rows) {
          const text = this.parseMessageText(msg);
          const ext = extBatch.get(msg.ROWID) ?? {};
          if (isHiddenSystemItem(ext.item_type)) continue;
          const converted = this.convertMessage(msg, text, chat.chat_identifier, ext);

          if (!includeReactions && converted.isReaction) continue;

          allMessages.push(converted);
        }
      } catch {
        // Skip chats that fail to load
      }
    }

    const result = allMessages.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit);
    span.end({ limit, returned: result.length });
    return result;
  }

  /**
   * Get messages from a specific conversation, sorted by date ascending (chronological).
   * By default excludes reactions (tapbacks) for cleaner output.
   */
  async getMessagesForChat(
    chatIdentifier: string,
    limit: number = 50,
    options: {
      includeReactions?: boolean;
      includeReactionDetails?: boolean;
      beforeMessageId?: number;
      afterMessageId?: number;
    } = {},
  ): Promise<Message[]> {
    const span = perf("getMessagesForChat");
    const {
      includeReactions = false,
      includeReactionDetails = false,
      beforeMessageId,
      afterMessageId,
    } = options;
    const chats = this.resolveChatsForConversation(chatIdentifier);
    if (chats.length === 0) {
      span.end({ limit, returned: 0 });
      return [];
    }

    const perChatLimit = Math.max(limit * 2, 50);
    // The pagination cursors are ids, but ordering is by date — resolve each
    // cursor's date so paging bounds messages by the composite (date, ROWID).
    const beforeDate = beforeMessageId != null ? this.dateOfMessage(beforeMessageId) : undefined;
    const afterDate = afterMessageId != null ? this.dateOfMessage(afterMessageId) : undefined;
    const result = new Map<number, Message>();
    for (const chat of chats) {
      const rows = this.fetchMessagesForChatRowId(
        chat.ROWID,
        perChatLimit,
        beforeMessageId,
        afterMessageId,
        beforeDate,
        afterDate,
      );
      const extBatch = this.fetchExtendedMessageDataBatch(rows.map((r) => r.ROWID));

      // Batch-fetch reactions for the entire chat instead of per-message LIKE queries
      const reactionsByGuid = includeReactionDetails
        ? this.fetchReactionsForChat(chat.ROWID)
        : undefined;

      for (const msg of rows) {
        const text = this.parseMessageText(msg);
        const ext = extBatch.get(msg.ROWID) ?? {};
        if (isHiddenSystemItem(ext.item_type)) continue;
        const converted = this.convertMessage(
          msg,
          text,
          chat.chat_identifier,
          ext,
          false, // don't let convertMessage fetch reactions individually
        );

        // Attach pre-fetched reactions
        if (reactionsByGuid && !converted.isReaction) {
          const rxns = reactionsByGuid.get(msg.guid);
          if (rxns && rxns.length > 0) {
            converted.reactions = this.consolidateReactions(rxns);
            if (converted.reactions.length === 0) converted.reactions = undefined;
          }
        }

        if (!includeReactions && converted.isReaction) continue;

        result.set(converted.id, converted);
      }
    }

    // Sort by timestamp ascending (chronological conversation order)
    const sorted = [...result.values()]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(-limit);
    span.end({ limit, chats: chats.length, returned: sorted.length });
    return sorted;
  }
  /**
   * Get one chronological export page for a conversation.
   *
   * This deliberately does not use getMessagesForChat's ROWID-only
   * beforeMessageId contract. Exports need to walk the whole conversation in
   * display order across every chat row that resolves to the same visible
   * thread, dedupe messages linked to multiple chats before applying LIMIT,
   * and avoid letting reaction/system rows consume page slots.
   */
  async getMessagesForChatExportPage(
    chatIdentifier: string,
    limit: number = 1000,
    options: {
      includeReactions?: boolean;
      includeReactionDetails?: boolean;
      afterCursor?: MessageExportCursor | null;
      since?: Date | null;
      until?: Date | null;
    } = {},
  ): Promise<MessageExportPage> {
    const span = perf("getMessagesForChatExportPage");
    const {
      includeReactions = false,
      includeReactionDetails = false,
      afterCursor,
      since,
      until,
    } = options;
    const pageLimit = Math.max(1, limit);
    const chats = this.resolveChatsForConversation(chatIdentifier);
    if (chats.length === 0) {
      span.end({ limit: pageLimit, returned: 0 });
      return { messages: [], nextCursor: null, rawCount: 0 };
    }

    const chatIds = chats.map((chat) => chat.ROWID);
    const chatPlaceholders = chatIds.map(() => "?").join(",");
    const conditions: string[] = [
      `cmj.chat_id IN (${chatPlaceholders})`,
      "COALESCE(m.item_type, 0) = 0",
    ];
    const params: unknown[] = [...chatIds];

    if (!includeReactions) {
      conditions.push(`COALESCE(m.associated_message_type, 0) = ${AssociatedMessageType.NORMAL}`);
    }
    if (afterCursor) {
      conditions.push("(m.date > ? OR (m.date = ? AND m.ROWID > ?))");
      params.push(afterCursor.date, afterCursor.date, afterCursor.rowid);
    }
    if (since) {
      conditions.push("m.date >= ?");
      params.push(dateToMacTimestamp(since));
    }
    if (until) {
      conditions.push("m.date <= ?");
      params.push(dateToMacTimestamp(until));
    }
    params.push(pageLimit);

    const stmt = this.raw.prepare(`
      WITH target_messages AS (
        SELECT
          m.ROWID,
          m.date,
          MIN(c.chat_identifier) as chat_identifier
        FROM ${Tables.MESSAGE} m
        JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
        JOIN ${Tables.CHAT} c ON c.ROWID = cmj.chat_id
        WHERE ${conditions.join("\n          AND ")}
        GROUP BY m.ROWID, m.date
        ORDER BY m.date ASC, m.ROWID ASC
        LIMIT ?
      )
      SELECT
        m.ROWID,
        m.guid,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me,
        h.id as handle_id,
        h.service as handle_service,
        m.cache_has_attachments,
        tm.chat_identifier,
        m.is_read,
        m.date_read,
        m.is_delivered,
        m.error,
        m.date_delivered,
        m.associated_message_type,
        m.associated_message_guid,
        m.associated_message_emoji,
        m.thread_originator_guid,
        m.thread_originator_part,
        m.balloon_bundle_id,
        m.item_type,
        m.date_edited,
        m.date_retracted,
        m.message_summary_info,
        m.payload_data
      FROM target_messages tm
      JOIN ${Tables.MESSAGE} m ON m.ROWID = tm.ROWID
      LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
      ORDER BY tm.date ASC, tm.ROWID ASC
    `);

    const rows = stmt.all(...params) as (MessageRow &
      ExtendedMessageData & { chat_identifier: string | null })[];
    const reactionsByGuid = new Map<string, Reaction[]>();
    if (includeReactionDetails) {
      for (const chat of chats) {
        for (const [guid, reactions] of this.fetchReactionsForChat(chat.ROWID)) {
          const existing = reactionsByGuid.get(guid);
          if (existing) existing.push(...reactions);
          else reactionsByGuid.set(guid, [...reactions]);
        }
      }
    }

    const messages: Message[] = [];
    for (const row of rows) {
      const text = this.parseMessageText(row);
      if (isHiddenSystemItem(row.item_type)) continue;
      const converted = this.convertMessage(
        row,
        text,
        row.chat_identifier ?? chatIdentifier,
        row,
        false,
      );
      if (!includeReactions && converted.isReaction) continue;

      if (includeReactionDetails && !converted.isReaction) {
        const reactions = reactionsByGuid.get(row.guid);
        if (reactions && reactions.length > 0) {
          converted.reactions = this.consolidateReactions(reactions);
          if (converted.reactions.length === 0) converted.reactions = undefined;
        }
      }
      messages.push(converted);
    }

    const lastRow = rows[rows.length - 1];
    const nextCursor = lastRow ? { date: lastRow.date, rowid: lastRow.ROWID } : null;
    span.end({
      limit: pageLimit,
      chats: chats.length,
      rows: rows.length,
      returned: messages.length,
    });
    return { messages, nextCursor, rawCount: rows.length };
  }

  /**
   * Get unread messages across all conversations, sorted by date descending (newest first).
   * Excludes reactions for cleaner output.
   * @param limit Max number of messages to return (default 100).
   */
  async getUnreadMessages(limit: number = 100): Promise<Message[]> {
    const span = perf("getUnreadMessages");
    const stmt = this.raw.prepare(`
      SELECT
        m.ROWID,
        m.guid,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me,
        h.id as handle_id,
        m.cache_has_attachments,
        c.chat_identifier
      FROM ${Tables.MESSAGE} m
      LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
      LEFT JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
      LEFT JOIN ${Tables.CHAT} c ON cmj.chat_id = c.ROWID
      WHERE m.is_from_me = 0
        AND m.is_read = 0
        AND m.associated_message_type = ${AssociatedMessageType.NORMAL}
        AND COALESCE(m.item_type, 0) = 0
      ORDER BY m.date DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as (MessageRow & { chat_identifier: string | null })[];
    const validRows = rows.filter((r) => r.chat_identifier != null);
    const extBatch = this.fetchExtendedMessageDataBatch(validRows.map((r) => r.ROWID));

    const result: Message[] = [];
    for (const row of validRows) {
      const text = this.parseMessageText(row);
      const ext = extBatch.get(row.ROWID) ?? {};
      result.push(this.convertMessage(row, text, row.chat_identifier!, ext));
    }

    result.sort((a, b) => b.date.getTime() - a.date.getTime());
    const sliced = result.slice(0, limit);
    span.end({ limit, rows: rows.length, returned: sliced.length });
    return sliced;
  }

  /**
   * Get the most recent message in a conversation
   */
  async getLastMessage(chatIdentifier: string): Promise<Message | null> {
    const messages = await this.getMessagesForChat(chatIdentifier, 1);
    return messages.length > 0 ? messages[messages.length - 1] : null;
  }

  /**
   * The service the conversation ACTUALLY works on, judged by delivery
   * evidence: the most recent message that either came FROM the other party
   * (any service they use reaches us) or was sent by us WITHOUT error.
   * Failed sends are excluded — otherwise one wrong-service attempt (e.g. an
   * iMessage 'sent' to an SMS-only number, error 22) mints a phantom leg,
   * flips the thread's apparent service, and every later send repeats the
   * mistake. Returns null when the conversation has no usable evidence.
   */
  getPreferredSendService(chatIdentifier: string): "iMessage" | "SMS" | null {
    const chats = this.resolveChatsForConversation(chatIdentifier);
    if (chats.length === 0) return null;
    const placeholders = chats.map(() => "?").join(",");
    const row = this.raw
      .prepare(
        `SELECT m.service
         FROM ${Tables.MESSAGE} m
         JOIN ${Tables.CHAT_MESSAGE_JOIN} j ON j.message_id = m.ROWID
         WHERE j.chat_id IN (${placeholders})
           AND (m.associated_message_type = 0 OR m.associated_message_type IS NULL)
           AND (m.is_from_me = 0 OR m.error = 0 OR m.error IS NULL)
           AND m.service IN ('iMessage', 'SMS')
         ORDER BY m.date DESC, m.ROWID DESC
         LIMIT 1`,
      )
      .get(...chats.map((c) => c.ROWID)) as { service: string } | undefined;
    if (row?.service === "SMS") return "SMS";
    if (row?.service === "iMessage") return "iMessage";
    return null;
  }

  /**
   * Aggregate stats over ALL merged legs of a conversation — one SQL
   * COUNT/MIN/MAX instead of materializing messages. Reactions and other
   * associated messages are excluded (normal items only). Used by
   * init_human to prefill first/last contact + volume.
   */
  getChatStats(chatIdentifier: string): { count: number; first: Date | null; last: Date | null } {
    const chats = this.resolveChatsForConversation(chatIdentifier);
    if (chats.length === 0) return { count: 0, first: null, last: null };
    const placeholders = chats.map(() => "?").join(",");
    const row = this.raw
      .prepare(
        // COUNT(DISTINCT m.ROWID): a single message is often joined to more
        // than one leg of a merged identity (Messages.app links it into both
        // the iMessage and SMS chat rows). Plain COUNT(*) counted it once per
        // leg and inflated the humans-file stats (e.g. +727 for one contact).
        `SELECT COUNT(DISTINCT m.ROWID) as count, MIN(m.date) as first, MAX(m.date) as last
         FROM ${Tables.MESSAGE} m
         JOIN ${Tables.CHAT_MESSAGE_JOIN} j ON j.message_id = m.ROWID
         WHERE j.chat_id IN (${placeholders})
           AND (m.associated_message_type = 0 OR m.associated_message_type IS NULL)`,
      )
      .get(...chats.map((c) => c.ROWID)) as {
      count: number;
      first: number | null;
      last: number | null;
    };
    return {
      count: row.count ?? 0,
      first: row.first != null ? macTimestampToDate(row.first) : null,
      last: row.last != null ? macTimestampToDate(row.last) : null,
    };
  }

  /**
   * Get messages after a specific message ID (for polling new messages).
   * Sorted by date ascending (chronological). By default returns incoming
   * messages only; `includeSelf` also returns from-me rows (the user's own
   * interjections from other devices) — callers using it must suppress the
   * agent's own send echo themselves (see SentEchoRegistry).
   */
  async getMessagesAfter(
    chatIdentifier: string,
    afterMessageId: number,
    options: { includeSelf?: boolean } = {},
  ): Promise<Message[]> {
    const messages = await this.getMessagesForChat(chatIdentifier, 1000, { afterMessageId });
    // "After" means after the boundary in (date, ROWID) order — NOT a bare id
    // comparison. A reply synced with a lower ROWID but later date is still
    // new; an id-only filter here silently dropped it (wait_for_reply missed
    // the reply). The SQL bound already excludes the boundary itself.
    const filtered = messages.filter(
      (m) => m.id !== afterMessageId && (options.includeSelf || !m.isFromMe),
    );
    filtered.sort((a, b) => a.date.getTime() - b.date.getTime());
    return filtered;
  }

  /**
   * List all conversations with metadata, sorted by last message date (newest first).
   * Populates lastMessageDate, lastMessageSnippet, and unreadCount to match Messages.app left pane.
   */
  async listConversations(limit: number = 200): Promise<Conversation[]> {
    const span = perf("listConversations");
    // Use the with-last-date variant so each row carries service_name — needed
    // to compute canonical slugs synchronously on the cold-start path below.
    const chats = this.getAllChatsWithLastDate();
    const lastByChat = this.getLastMessageByChat();
    const unreadByChat = this.getUnreadByChat();

    // ── Pass 1: lightweight sort entries for ALL chats (no DB lookups) ──
    type SortEntry = {
      chat: ChatWithLastDate;
      lastDate: number;
      isGroup: boolean;
      last?: LastConversationRow;
    };
    const sortEntries: SortEntry[] = chats.map((chat) => ({
      chat,
      lastDate: lastByChat[chat.ROWID]?.lastDate ?? 0,
      isGroup: isGroupGuid(chat.guid) || isGroupChatIdentifier(chat.chat_identifier),
      last: lastByChat[chat.ROWID],
    }));

    // Sort by last message date descending; ROWID DESC breaks ties so ordering
    // stays deterministic (matches the old getAllChats ORDER BY ROWID DESC).
    sortEntries.sort((a, b) => b.lastDate - a.lastDate || b.chat.ROWID - a.chat.ROWID);

    // ── Pass 2: enrich lazily in chunks until enough DEDUPED rows exist ──
    // A fixed over-fetch factor (previously limit*3) starves offset paging
    // when many chat rows merge into few conversations: the deduped list came
    // up short of the requested window and the page silently truncated. Keep
    // enriching until the deduped count reaches `limit` or chats run out.
    const enrich = ({ chat, isGroup, last }: SortEntry) => {
      const lastDate = last ? macTimestampToDate(last.lastDate) : null;
      const rawIdentifier = chat.chat_identifier;

      let displayName = chat.display_name;
      if (!displayName && rawIdentifier && !isGroup) {
        const resolved = this.contacts.lookupHandle(rawIdentifier);
        displayName = resolved !== rawIdentifier ? resolved : null;
      }

      const participants = isGroup ? this.fetchChatParticipants(chat.ROWID) : [rawIdentifier];
      const mergeKey = this.getConversationMergeKey(rawIdentifier, chat.guid, isGroup);
      // Cold start: single-shot CLI runs exit before the background slug sync
      // persists, so the store lookup misses. Compute + persist the canonical
      // slug synchronously so `imsg list` shows ~service~hash slugs, not raw ids.
      const slug = this.getSlugForChatGuid(chat.guid) ?? this.syncSlugForChat(chat);
      // Badge reflects the identity's canonical service (prefer iMessage), not
      // whichever leg won the merge — otherwise a single newer SMS leg flips a
      // fundamentally-iMessage thread to "SMS" and disagrees with the ~imsg~ slug.
      const serviceType = this.canonicalServiceForChat(chat);

      return {
        last,
        mergeKey,
        conversation: {
          chatId: chat.guid,
          chatIdentifier: rawIdentifier,
          displayName: displayName || null,
          rawIdentifier,
          participants,
          lastMessageDate: lastDate,
          lastMessageSnippet: null,
          unreadCount: unreadByChat[chat.ROWID] ?? 0,
          threadSlug: slug,
          isGroupChat: isGroup,
          serviceType,
        } satisfies Conversation,
      };
    };

    const CHUNK = Math.max(limit, 200);
    const prepared: ReturnType<typeof enrich>[] = [];
    let cursor = 0;
    let deduped = mergeDuplicateConversations(prepared);
    while (deduped.length < limit && cursor < sortEntries.length) {
      const chunk = sortEntries.slice(cursor, cursor + CHUNK);
      cursor += chunk.length;
      for (const entry of chunk) prepared.push(enrich(entry));
      deduped = mergeDuplicateConversations(prepared);
    }
    const selected = deduped.slice(0, limit);

    const result = selected.map(({ conversation, last }) => ({
      ...conversation,
      lastMessageSnippet: this.resolveConversationSnippet(last),
    }));
    span.end({
      chats: chats.length,
      enriched: cursor,
      deduped: deduped.length,
      returned: result.length,
    });
    return result;
  }

  /**
   * Find a chat by phone number, email, or chat identifier.
   * Uses a single join (chats + last message date), then filters and sorts by date.
   * When multiple chats match (e.g. same number, different threads), returns the one with the most recent message.
   */
  async findChatByHandle(handle: string): Promise<Conversation | null> {
    const chats = this.getAllChatsWithLastDate();

    // Normalize the search handle
    const normalized = handle.replace(/[\s\-()]/g, "").toLowerCase();

    const matches = chats.filter((chat) => {
      const chatNorm = chat.chat_identifier?.replace(/[\s\-()]/g, "").toLowerCase() || "";
      return chatNorm.includes(normalized) || normalized.includes(chatNorm);
    });

    if (matches.length === 0) return null;

    const found = this.pickMostRecentChat(matches);
    const rawIdentifier = found.chat_identifier;
    const isGroup = isGroupGuid(found.guid) || isGroupChatIdentifier(rawIdentifier);
    let displayName = found.display_name;
    if (!displayName && rawIdentifier && !isGroup) {
      const resolved = this.contacts.lookupHandle(rawIdentifier);
      displayName = resolved !== rawIdentifier ? resolved : null;
    }

    const slug = this.getSlugForChatGuid(found.guid) ?? this.syncSlugForChat(found);
    // Identity-canonical service (prefer iMessage) — matches the slug + send route.
    const serviceType = this.canonicalServiceForChat(found);

    return {
      chatId: found.guid,
      chatIdentifier: rawIdentifier,
      displayName: displayName || null,
      rawIdentifier,
      participants: isGroup ? this.fetchChatParticipants(found.ROWID) : [rawIdentifier],
      lastMessageDate: null,
      lastMessageSnippet: null,
      unreadCount: 0,
      threadSlug: slug,
      isGroupChat: isGroup,
      serviceType,
    };
  }

  /**
   * Search messages across all conversations.
   *
   * Strategy: search the `text` column via LIKE first (covers most messages).
   * For messages where text is NULL but attributedBody exists, we fetch a larger
   * window and post-filter after parsing the blob.  The upstream imessage-parser
   * had a bug here: its SQL `WHERE text LIKE ? OR attributedBody IS NOT NULL`
   * with a LIMIT meant the LIMIT was consumed by non-matching attributedBody rows,
   * hiding older text matches entirely.
   */
  async searchMessages(query: string, limit: number = 20): Promise<Message[]> {
    const span = perf("searchMessages");
    // Phase 1: direct text match -- fast and reliable
    const textStmt = this.raw.prepare(`
      SELECT
        m.ROWID, m.guid, m.text, m.attributedBody, m.date,
        m.is_from_me, h.id as handle_id, m.cache_has_attachments,
        c.chat_identifier
      FROM ${Tables.MESSAGE} m
      LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
      LEFT JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
      LEFT JOIN ${Tables.CHAT} c ON cmj.chat_id = c.ROWID
      WHERE m.text LIKE ?
        AND m.associated_message_type = ${AssociatedMessageType.NORMAL}
        AND COALESCE(m.item_type, 0) = 0
      ORDER BY m.date DESC
      LIMIT ?
    `);

    const textRows = textStmt.all(`%${query}%`, limit * 2) as (MessageRow & {
      chat_identifier: string | null;
    })[];
    const seenIds = new Set<number>();
    const messages: Message[] = [];

    for (const row of textRows) {
      if (!row.chat_identifier) continue;
      seenIds.add(row.ROWID);
      const text = this.parseMessageText(row);
      const ext = this.fetchExtendedMessageData(row.ROWID);
      if (isHiddenSystemItem(ext.item_type)) continue;
      const converted = this.convertMessage(row, text, row.chat_identifier, ext);
      if (converted.isReaction) continue;
      messages.push(converted);
      if (messages.length >= limit) return messages;
    }

    // Phase 2: scan attributedBody-only messages (text IS NULL) for matches
    // Use a generous window so we don't miss older messages
    const blobStmt = this.raw.prepare(`
      SELECT
        m.ROWID, m.guid, m.text, m.attributedBody, m.date,
        m.is_from_me, h.id as handle_id, m.cache_has_attachments,
        c.chat_identifier
      FROM ${Tables.MESSAGE} m
      LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
      LEFT JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
      LEFT JOIN ${Tables.CHAT} c ON cmj.chat_id = c.ROWID
      WHERE m.text IS NULL
        AND m.attributedBody IS NOT NULL
        AND m.associated_message_type = ${AssociatedMessageType.NORMAL}
        AND COALESCE(m.item_type, 0) = 0
      ORDER BY m.date DESC
      LIMIT ?
    `);

    const blobRows = blobStmt.all(limit * 20) as (MessageRow & {
      chat_identifier: string | null;
    })[];
    const queryLower = query.toLowerCase();

    for (const row of blobRows) {
      if (!row.chat_identifier || seenIds.has(row.ROWID)) continue;
      const text = this.parseMessageText(row);
      if (!text || !text.toLowerCase().includes(queryLower)) continue;
      const ext = this.fetchExtendedMessageData(row.ROWID);
      if (isHiddenSystemItem(ext.item_type)) continue;
      const converted = this.convertMessage(row, text, row.chat_identifier, ext);
      if (converted.isReaction) continue;
      messages.push(converted);
      if (messages.length >= limit) break;
    }

    span.end({
      query,
      limit,
      textHits: textRows.length,
      blobScanned: blobRows.length,
      returned: messages.length,
    });
    return messages;
  }

  /**
   * Resolve a free-form query ("Selena", "the plumber", "mum") to ranked
   * conversations. Fuses three signals so an agent lands the right thread in
   * one call instead of chaining search_contacts → get_contact:
   *   1. contacts  — authoritative names from the Address Book (strongest)
   *   2. thread    — recent-conversation display names / group names
   *   3. message   — conversations whose message text matches (weakest)
   * Deduped per thread (slug), keeping the strongest signal, sorted by score
   * then recency.
   */
  async resolveConversation(query: string, limit = 10): Promise<ResolvedConversation[]> {
    const q = query.trim();
    if (!q) return [];
    const MIN_SCORE = 0.4;
    const PRIORITY: Record<ResolvedConversation["matchType"], number> = {
      contact: 3,
      thread: 2,
      message: 1,
    };

    const convs = await this.listConversations(200);
    const bySlug = new Map<string, Conversation>();
    const byIdentifier = new Map<string, Conversation>();
    for (const c of convs) {
      bySlug.set(c.threadSlug, c);
      byIdentifier.set(c.chatIdentifier, c);
      for (const p of c.participants) if (!byIdentifier.has(p)) byIdentifier.set(p, c);
    }

    const results = new Map<string, ResolvedConversation>();
    const isBetter = (a: ResolvedConversation, b: ResolvedConversation) =>
      a.score !== b.score ? a.score > b.score : PRIORITY[a.matchType] > PRIORITY[b.matchType];
    const consider = (key: string, cand: ResolvedConversation) => {
      const prev = results.get(key);
      if (!prev || isBetter(cand, prev)) results.set(key, cand);
    };

    // 1. Thread-name matches (display name or, for un-named chats, identifier).
    for (const c of convs) {
      const name = c.displayName ?? c.chatIdentifier;
      const score = fuzzyScore(q, name);
      if (score >= MIN_SCORE) {
        consider(c.threadSlug, {
          name,
          threadSlug: c.threadSlug,
          chatIdentifier: c.chatIdentifier,
          lastMessageDate: c.lastMessageDate,
          matchType: "thread",
          score,
        });
      }
    }

    // 2. Contact matches — authoritative names resolved to a thread via handle.
    for (const contact of this.contacts.searchContacts(q).slice(0, 25)) {
      let matched: Conversation | null = null;
      for (const handle of [...contact.phoneNumbers, ...contact.emails]) {
        const conv = await this.findChatByHandle(handle);
        if (conv?.threadSlug) {
          // Prefer the enriched conversation (carries lastMessageDate).
          matched = bySlug.get(conv.threadSlug) ?? conv;
          break;
        }
      }
      if (!matched) continue;
      consider(matched.threadSlug, {
        name: contact.displayName,
        threadSlug: matched.threadSlug,
        chatIdentifier: matched.chatIdentifier,
        lastMessageDate: matched.lastMessageDate ?? null,
        matchType: "contact",
        // Contacts are a strong signal; floor the fuzzy score so an exact
        // Address-Book hit outranks an incidental thread-name substring.
        score: Math.max(fuzzyScore(q, contact.displayName), 0.9),
      });
    }

    // 3. Message-content matches — only surface threads not already found by a
    //    stronger signal, so a name query stays name-first.
    const msgs = await this.searchMessages(q, 20);
    for (const m of msgs) {
      const slug = this.getSlugForChatIdentifier(m.chatId) ?? m.chatId;
      if (results.has(slug)) continue;
      const conv = bySlug.get(slug) ?? byIdentifier.get(m.chatId);
      consider(slug, {
        name: conv?.displayName ?? m.displayName ?? m.chatId,
        threadSlug: conv?.threadSlug ?? (slug.includes("~") ? slug : null),
        chatIdentifier: conv?.chatIdentifier ?? m.chatId,
        lastMessageDate: conv?.lastMessageDate ?? m.date,
        matchType: "message",
        score: 0.5,
      });
    }

    return [...results.values()]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.lastMessageDate?.getTime() ?? 0) - (a.lastMessageDate?.getTime() ?? 0);
      })
      .slice(0, limit);
  }

  /**
   * Get a deep link to open a specific conversation in Messages.app
   */
  getConversationLink(chatIdentifier: string): string {
    return `imessage://${encodeURIComponent(chatIdentifier)}`;
  }

  private resolveConversationSnippet(last?: LastConversationRow): string | null {
    if (!last) return null;
    const cached = this.cachedSnippets.get(last.lastMessageId);
    if (cached !== undefined) return cached;

    let result: string | null = null;

    const directSnippet = pickConversationSnippet({ rawText: last.snippet });
    if (directSnippet && !this.shouldFallbackToPreviousSnippet(directSnippet, last)) {
      result = directSnippet;
    }

    if (result == null) {
      const parsedSnippet = pickConversationSnippet({
        parsedText: this.getMessageTextByRowId(last.lastMessageId),
      });
      if (parsedSnippet && !this.shouldFallbackToPreviousSnippet(parsedSnippet, last)) {
        result = parsedSnippet;
      }
    }

    if (result == null) {
      result = this.getPreviousConversationSnippet(last);
    }

    // When the last message carries no text at all — an UNSENT message (empty
    // attributedBody + retract markers in message_summary_info), or any other
    // tombstone — the same-sender/60s scan above bails immediately. Fall back
    // to the most recent message in the chat that DOES have text, regardless of
    // sender, so the preview stays useful (and never surfaces chat-properties
    // noise). Messages.app similarly reverts the list preview after an unsend.
    if (result == null) {
      result = this.getLastTextfulSnippet(last);
    }

    if (result == null) {
      result = pickConversationSnippet({
        summaryText: extractChatSummaryText(last.chatProperties) ?? null,
      });
    }

    this.cachedSnippets.set(last.lastMessageId, result);
    return result;
  }

  /**
   * Most recent message in the chat (any sender) with real extractable text,
   * looking back from the current last message. Unlike
   * getPreviousConversationSnippet this does NOT stop at a sender change or a
   * time gap — it exists for the "last message is a text-less tombstone"
   * (unsent/retracted) case, where the useful preview is simply the previous
   * real message.
   */
  private getLastTextfulSnippet(last: LastConversationRow): string | null {
    const rows = this.raw
      .prepare(`
      SELECT m.text, m.attributedBody, m.ROWID
      FROM ${Tables.MESSAGE} m
      JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON cmj.message_id = m.ROWID
      WHERE cmj.chat_id = ?
        AND m.associated_message_type = ${AssociatedMessageType.NORMAL}
        AND COALESCE(m.item_type, 0) = 0
        AND (m.date < ? OR (m.date = ? AND m.ROWID < ?))
      ORDER BY m.date DESC, m.ROWID DESC
      LIMIT 10
    `)
      .all(last.chatId, last.lastDate, last.lastDate, last.lastMessageId) as Array<{
      text: string | null;
      attributedBody: Buffer | null;
      ROWID: number;
    }>;

    for (const row of rows) {
      const snippet = pickConversationSnippet({
        rawText: row.text,
        parsedText: this.extractMessageText(row),
      });
      if (snippet && !isMetadataOnlySnippet(snippet)) return snippet;
    }
    return null;
  }

  private shouldFallbackToPreviousSnippet(snippet: string, last: LastConversationRow): boolean {
    return Boolean(
      last.balloonBundleId?.includes("URLBalloonProvider") && isMetadataOnlySnippet(snippet),
    );
  }

  private getPreviousConversationSnippet(last: LastConversationRow): string | null {
    const rows = this.raw
      .prepare(`
      SELECT m.ROWID, m.text, m.attributedBody, m.date, m.is_from_me
      FROM ${Tables.MESSAGE} m
      JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON cmj.message_id = m.ROWID
      WHERE cmj.chat_id = ?
        AND m.associated_message_type = ${AssociatedMessageType.NORMAL}
        AND COALESCE(m.item_type, 0) = 0
        AND (m.date < ? OR (m.date = ? AND m.ROWID < ?))
      ORDER BY m.date DESC, m.ROWID DESC
      LIMIT 5
    `)
      .all(last.chatId, last.lastDate, last.lastDate, last.lastMessageId) as Array<{
      ROWID: number;
      text: string | null;
      attributedBody: Buffer | null;
      date: number;
      is_from_me: number;
    }>;

    for (const row of rows) {
      if (Boolean(row.is_from_me) !== last.lastIsFromMe) break;
      if (Math.abs(last.lastDate - row.date) > 60_000_000_000) break;

      const snippet = pickConversationSnippet({
        rawText: row.text,
        parsedText: this.extractMessageText(row),
      });

      if (snippet && !isMetadataOnlySnippet(snippet)) {
        return snippet;
      }
    }

    return null;
  }

  private getConversationMergeKey(
    chatIdentifier: string,
    chatGuid: string,
    isGroup: boolean,
  ): string {
    const cacheKey = `${chatIdentifier}::${chatGuid}::${isGroup}`;
    const cached = this.cachedMergeKeys.get(cacheKey);
    if (cached) return cached;

    let key: string;
    if (isGroup) {
      key = `group:${chatGuid}`;
    } else {
      const contact = this.contacts.lookupContact(chatIdentifier);
      key = contact
        ? `contact:${contact.contactId}`
        : `identifier:${chatIdentifier.replace(/[\s\-()]/g, "").toLowerCase()}`;
    }

    this.cachedMergeKeys.set(cacheKey, key);
    return key;
  }

  private resolveChatsForConversation(identifier: string): ChatRow[] {
    const chats = this.getAllChatsWithLastDate();
    const normalized = identifier.replace(/[\s\-()]/g, "").toLowerCase();
    const chatNorm = (chat: ChatWithLastDate) =>
      (chat.chat_identifier ?? "").replace(/[\s\-()]/g, "").toLowerCase();

    // Exact matches win outright: raw identifier, guid, or normalized-equal
    // (tolerates phone punctuation/format differences without over-matching).
    const exactMatches = chats.filter(
      (chat) =>
        chat.chat_identifier === identifier ||
        chat.guid === identifier ||
        (chat.chat_identifier != null && chatNorm(chat) === normalized),
    );

    // Fuzzy fallback ONLY when nothing matched exactly, and ONLY for phone-like
    // numbers — a SUFFIX comparison with a minimum overlap (country-code
    // tolerance: "5551234567" ↔ "+15551234567"). The previous bidirectional
    // `includes` over-matched: a short shared fragment could fold in the wrong
    // identity, and near-identical emails collided ("a@b.co" ⊂ "a@b.com").
    const MIN_FUZZY_PHONE_LEN = 7;
    const directMatches =
      exactMatches.length > 0
        ? exactMatches
        : normalized.includes("@") || normalized.length < MIN_FUZZY_PHONE_LEN
          ? []
          : chats.filter((chat) => {
              if (chat.chat_identifier == null) return false;
              const cn = chatNorm(chat);
              if (cn.length < MIN_FUZZY_PHONE_LEN || cn.includes("@")) return false;
              return cn.endsWith(normalized) || normalized.endsWith(cn);
            });

    if (directMatches.length === 0) return [];

    const representative = this.pickMostRecentChat(directMatches);
    const isGroup =
      isGroupGuid(representative.guid) || isGroupChatIdentifier(representative.chat_identifier);
    if (isGroup) return [representative];

    const mergeKey = this.getConversationMergeKey(
      representative.chat_identifier,
      representative.guid,
      false,
    );

    return chats
      .filter(
        (chat) =>
          !(isGroupGuid(chat.guid) || isGroupChatIdentifier(chat.chat_identifier)) &&
          this.getConversationMergeKey(chat.chat_identifier, chat.guid, false) === mergeKey,
      )
      .map((chat) => toChatRow(chat));
  }

  /**
   * Completeness diagnostic for exports. Finds non-group chats that belong to
   * the same identity as the exported conversation but that the merge-key logic
   * did NOT fold in — e.g. a contact whose phone and email landed on separate
   * Address Book cards, or chats Apple linked via `person_centric_id`.
   *
   * Two independent signals, unioned and deduped by chat ROWID:
   *  1. **contactId invariant** (primary): any non-group chat whose handle
   *     resolves (via the loaded Address Books, incl. iCloud sources) to the
   *     same contactId as the merged set but wasn't merged. Catches merge
   *     regressions and normalization gaps.
   *  2. **person_centric_id** (fallback): Apple's own cross-handle link. Still
   *     fires when the contact isn't in any Address Book — but note this column
   *     is NULL on many real chat.dbs, so signal (1) is the dependable one.
   *
   * Inherent limit: a contact in NO Address Book *and* with a NULL
   * person_centric_id cannot be linked from data alone — that case is guarded
   * by the cross-source merge tests, not this diagnostic. Read-only.
   */
  findUnmergedSiblingChats(chatIdentifier: string): UnmergedSiblingChat[] {
    const merged = this.resolveChatsForConversation(chatIdentifier);
    if (merged.length === 0) return [];

    const mergedIds = new Set(merged.map((c) => c.ROWID));
    const siblings = new Map<number, UnmergedSiblingChat>();

    const isGroupChat = (guid: string, ident: string | null): boolean =>
      isGroupGuid(guid) || isGroupChatIdentifier(ident ?? "");

    // ── Signal 1: same resolved contactId, not merged ──
    const mergedContactIds = new Set<number>();
    for (const chat of merged) {
      const contact = this.contacts.lookupContact(chat.chat_identifier);
      if (contact) mergedContactIds.add(contact.contactId);
    }
    if (mergedContactIds.size > 0) {
      for (const chat of this.getAllChatsWithLastDate()) {
        if (mergedIds.has(chat.ROWID)) continue;
        if (isGroupChat(chat.guid, chat.chat_identifier)) continue;
        const contact = this.contacts.lookupContact(chat.chat_identifier);
        if (contact && mergedContactIds.has(contact.contactId)) {
          siblings.set(chat.ROWID, {
            chatIdentifier: chat.chat_identifier,
            reason: "resolves to the same contact but was not merged",
          });
        }
      }
    }

    // ── Signal 2: shared person_centric_id, not merged ──
    const mergedIdList = [...mergedIds];
    const placeholders = mergedIdList.map(() => "?").join(",");
    const rows = this.raw
      .prepare(`
        SELECT DISTINCT c.ROWID as rowid, c.guid, c.chat_identifier
        FROM ${Tables.CHAT} c
        JOIN ${Tables.CHAT_HANDLE_JOIN} chj ON chj.chat_id = c.ROWID
        JOIN ${Tables.HANDLE} h ON h.ROWID = chj.handle_id
        WHERE c.ROWID NOT IN (${placeholders})
          AND h.person_centric_id IN (
            SELECT DISTINCT h2.person_centric_id
            FROM ${Tables.CHAT_HANDLE_JOIN} chj2
            JOIN ${Tables.HANDLE} h2 ON h2.ROWID = chj2.handle_id
            WHERE chj2.chat_id IN (${placeholders})
              AND h2.person_centric_id IS NOT NULL
              AND h2.person_centric_id != ''
          )
      `)
      .all(...mergedIdList, ...mergedIdList) as {
      rowid: number;
      guid: string;
      chat_identifier: string | null;
    }[];
    for (const row of rows) {
      if (isGroupChat(row.guid, row.chat_identifier)) continue;
      if (siblings.has(row.rowid)) continue;
      siblings.set(row.rowid, {
        chatIdentifier: row.chat_identifier ?? row.guid,
        reason: "shares this contact's identity (person_centric_id) but was not merged",
      });
    }

    return [...siblings.values()];
  }

  /**
   * Get all chats with their last message date in one join query.
   * Used to resolve the correct chat for a contact when multiple chats exist (e.g. same number).
   * Results are suitable for filtering by handle/identifier then sorting by last_date descending.
   */
  private getAllChatsWithLastDate(): ChatWithLastDate[] {
    const now = Date.now();
    if (this.cachedAllChats && now - this.cachedAllChats.ts < IMessageDB.CACHE_TTL_MS) {
      return this.cachedAllChats.data;
    }
    const stmt = this.raw.prepare(`
      SELECT
        c.ROWID as rowid,
        c.guid,
        c.chat_identifier,
        c.display_name,
        c.service_name,
        (SELECT MAX(m.date)
         FROM ${Tables.CHAT_MESSAGE_JOIN} cmj
         JOIN ${Tables.MESSAGE} m ON cmj.message_id = m.ROWID
         WHERE cmj.chat_id = c.ROWID
           AND m.associated_message_type = ${AssociatedMessageType.NORMAL}
           AND COALESCE(m.item_type, 0) = 0) as last_date
       FROM ${Tables.CHAT} c
     `);
    const rows = stmt.all() as {
      rowid: number;
      guid: string;
      chat_identifier: string;
      display_name: string | null;
      service_name: string | null;
      last_date: number | null;
    }[];
    const data = rows.map((r) => ({
      ROWID: r.rowid,
      guid: r.guid,
      chat_identifier: r.chat_identifier,
      display_name: r.display_name,
      service_name: r.service_name,
      last_date: r.last_date,
    }));
    this.cachedAllChats = { data, ts: now };
    return data;
  }

  /** Last message metadata per chat (window function over message table). Cached with TTL. */
  private getLastMessageByChat(): Record<number, LastConversationRow> {
    const now = Date.now();
    if (this.cachedLastByChat && now - this.cachedLastByChat.ts < IMessageDB.CACHE_TTL_MS) {
      return this.cachedLastByChat.data;
    }
    const stmt = this.raw.prepare(`
      SELECT chat_id, last_date, last_message_id, last_service, last_is_from_me, balloon_bundle_id, snippet, chat_properties FROM (
        SELECT cmj.chat_id, m.date as last_date, m.ROWID as last_message_id,
          m.service as last_service,
          m.is_from_me as last_is_from_me,
          m.balloon_bundle_id as balloon_bundle_id,
          COALESCE(TRIM(SUBSTR(m.text, 1, 200)), '') as snippet,
          c.properties as chat_properties,
          ROW_NUMBER() OVER (PARTITION BY cmj.chat_id ORDER BY m.date DESC) as rn
        FROM ${Tables.MESSAGE} m
        JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
        JOIN ${Tables.CHAT} c ON c.ROWID = cmj.chat_id
        WHERE m.associated_message_type = ${AssociatedMessageType.NORMAL}
          AND COALESCE(m.item_type, 0) = 0
      ) WHERE rn = 1
    `);
    const data = (
      stmt.all() as {
        chat_id: number;
        last_date: number;
        last_message_id: number;
        last_service: string | null;
        last_is_from_me: number;
        balloon_bundle_id: string | null;
        snippet: string;
        chat_properties: Buffer | null;
      }[]
    ).reduce(
      (acc, row) => {
        acc[row.chat_id] = {
          chatId: row.chat_id,
          lastDate: row.last_date,
          lastMessageId: row.last_message_id,
          lastService: row.last_service,
          lastIsFromMe: Boolean(row.last_is_from_me),
          balloonBundleId: row.balloon_bundle_id,
          snippet: row.snippet || null,
          chatProperties: row.chat_properties,
        };
        return acc;
      },
      {} as Record<number, LastConversationRow>,
    );
    this.cachedLastByChat = { data, ts: now };
    return data;
  }

  /** Unread count per chat. Cached with TTL. */
  private getUnreadByChat(): Record<number, number> {
    const now = Date.now();
    if (this.cachedUnreadByChat && now - this.cachedUnreadByChat.ts < IMessageDB.CACHE_TTL_MS) {
      return this.cachedUnreadByChat.data;
    }
    const stmt = this.raw.prepare(`
      SELECT cmj.chat_id, COUNT(*) as unread
      FROM ${Tables.MESSAGE} m
      JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
      WHERE m.associated_message_type = ${AssociatedMessageType.NORMAL}
        AND COALESCE(m.item_type, 0) = 0
        AND m.is_from_me = 0 AND m.is_read = 0
      GROUP BY cmj.chat_id
    `);
    const data = (stmt.all() as { chat_id: number; unread: number }[]).reduce(
      (acc, row) => {
        acc[row.chat_id] = row.unread;
        return acc;
      },
      {} as Record<number, number>,
    );
    this.cachedUnreadByChat = { data, ts: now };
    return data;
  }

  /** Resolve a message ROWID to its date (for composite pagination cursors). */
  private dateOfMessage(rowid: number): number | undefined {
    const row = this.raw.prepare(`SELECT date FROM ${Tables.MESSAGE} WHERE ROWID = ?`).get(rowid) as
      | { date: number }
      | undefined;
    return row?.date;
  }

  /**
   * Fetch message rows for a chat ROWID, ordered by date DESC.
   *
   * Pagination boundaries are composite `(date, ROWID)` cursors, NOT bare
   * ROWID comparisons: results are ordered by date, and in restored/merged
   * threads ROWID order diverges from date order — a ROWID-only bound both
   * skips older-date/higher-ROWID messages and re-shows newer-date/lower-ROWID
   * ones (paginating a real thread that way reached only ~47% of it; the same
   * defect made wait_for_reply able to miss replies entirely). ROWID-only is
   * kept solely as a fallback when the boundary message's date is unknown
   * (e.g. the boundary row was deleted).
   */
  private fetchMessagesForChatRowId(
    chatRowId: number,
    limit: number,
    beforeMessageId?: number,
    afterMessageId?: number,
    beforeDate?: number,
    afterDate?: number,
  ): MessageRow[] {
    const conditions: string[] = ["cmj.chat_id = ?"];
    const params: unknown[] = [chatRowId];

    if (beforeMessageId != null) {
      if (beforeDate != null) {
        conditions.push("(m.date < ? OR (m.date = ? AND m.ROWID < ?))");
        params.push(beforeDate, beforeDate, beforeMessageId);
      } else {
        conditions.push("m.ROWID < ?");
        params.push(beforeMessageId);
      }
    }
    if (afterMessageId != null) {
      if (afterDate != null) {
        conditions.push("(m.date > ? OR (m.date = ? AND m.ROWID > ?))");
        params.push(afterDate, afterDate, afterMessageId);
      } else {
        conditions.push("m.ROWID > ?");
        params.push(afterMessageId);
      }
    }
    params.push(limit);

    const stmt = this.raw.prepare(`
      SELECT
        m.ROWID, m.guid, m.text, m.attributedBody, m.date,
        m.is_from_me, h.id as handle_id, m.cache_has_attachments
      FROM ${Tables.MESSAGE} m
      LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
      LEFT JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.date DESC, m.ROWID DESC
      LIMIT ?
    `);
    return stmt.all(...params) as MessageRow[];
  }

  /**
   * Extract readable text from a message row.
   * Prefers the plain text column; falls back to parsing the attributedBody blob.
   * Replaces the upstream IMessageDatabase.parseMessage().
   */
  private parseMessageText(row: MessageRow): string | null {
    if (row.text && !isPlaceholderText(row.text)) return row.text;
    return extractAttributedBodyText(row.attributedBody) || null;
  }

  /**
   * From a list of chats with last_date, return the one with the most recent message (sort by last_date desc).
   */
  private pickMostRecentChat(chats: ChatWithLastDate[]): ChatWithLastDate {
    if (chats.length === 0) throw new Error("pickMostRecentChat requires at least one chat");
    if (chats.length === 1) return chats[0];
    const sorted = chats.slice().sort((a, b) => {
      const aDate = a.last_date ?? 0;
      const bDate = b.last_date ?? 0;
      return bDate - aDate;
    });
    return sorted[0];
  }

  /**
   * Helper to find chat by identifier.
   * When multiple chats match (e.g. same number in different services), returns the one with the most recent message.
   */
  private findChatByIdentifier(identifier: string): ChatRow | null {
    const chats = this.getAllChatsWithLastDate();
    const matches = chats.filter(
      (c) =>
        c.chat_identifier === identifier ||
        c.guid === identifier ||
        (c.chat_identifier != null &&
          (c.chat_identifier.includes(identifier) || identifier.includes(c.chat_identifier))),
    );
    if (matches.length === 0) return null;
    return this.pickMostRecentChat(matches);
  }

  /**
   * Convert a raw message row to our Message type with full extended data
   */
  private convertMessage(
    raw: MessageRow,
    text: string | null,
    chatId: string,
    extended?: ExtendedMessageData,
    includeReactions: boolean = false,
  ): Message {
    // If no extended data provided, fetch it
    const ext = extended || this.fetchExtendedMessageData(raw.ROWID);

    // Clean up text - handle object replacement characters and other special chars
    let cleanText = text || raw.text || null;
    if (isPlaceholderText(cleanText)) {
      const attributedText = extractAttributedBodyText(raw.attributedBody ?? null) || null;
      if (attributedText) {
        cleanText = attributedText;
      }
    }
    if (cleanText) {
      // U+FFFC is Object Replacement Character (inline attachment placeholder); see db-schema
      // U+FFFD is Replacement Character (invalid UTF-8)
      const re = new RegExp(
        `${OBJECT_REPLACEMENT_CHAR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}+`,
        "g",
      );
      cleanText = cleanText
        .replace(re, "📎 ") // Use paperclip emoji for inline attachments
        .replace(/\uFFFD/g, "")
        .trim();

      // If only attachment markers remain, indicate it's an attachment-only message
      if (!cleanText || cleanText === "📎" || /^(📎\s*)+$/.test(cleanText)) {
        cleanText = "(image/attachment)";
      }

      if (ext.balloon_bundle_id?.includes("URLBalloonProvider")) {
        cleanText = normalizeRichMetadataText(cleanText) ?? cleanText;
      }
    }

    // Determine if this is a reaction (see db-schema.ts and docs)
    const associatedType = ext.associated_message_type ?? AssociatedMessageType.NORMAL;
    const isReaction = isReactionType(associatedType);

    // Parse reaction info
    let reaction: Reaction | undefined;
    if (isReaction && ext.associated_message_guid) {
      const typeInfo = TAPBACK_TYPE_MAP[associatedType] || {
        type: "unknown" as TapbackType,
        isRemoval: false,
      };
      const parsed = parseAssociatedMessageGuid(ext.associated_message_guid);

      reaction = {
        type: typeInfo.type,
        emoji: ext.associated_message_emoji || undefined,
        fromHandle: raw.is_from_me ? "me" : ext.handle_id || "unknown",
        isRemoval: typeInfo.isRemoval,
        targetMessageGuid: parsed?.targetGuid || "",
        targetMessagePart: parsed?.partIndex || 0,
      };
    }

    // Determine if this is a reply
    const isReply = Boolean(ext.thread_originator_guid);
    let replyTo: ReplyContext | undefined;
    if (isReply && ext.thread_originator_guid) {
      replyTo = this.getReplyContextByGuid(ext.thread_originator_guid);
    }

    // Get rich content type
    const richContentType = getRichContentType(ext.balloon_bundle_id || null);

    // Get attachments if needed
    const hasAttachments = Boolean(ext.cache_has_attachments);
    let attachments: Attachment[] | undefined;
    if (hasAttachments) {
      attachments = this.fetchAttachments(raw.ROWID);
    }

    // Get reactions for this message if requested
    let reactions: Reaction[] | undefined;
    if (includeReactions && !isReaction) {
      reactions = this.fetchReactionsForMessage(raw.guid);
      // Filter out removal reactions that cancel out adds
      if (reactions.length > 0) {
        reactions = this.consolidateReactions(reactions);
      }
      if (reactions.length === 0) reactions = undefined;
    }

    // Resolve display name from contacts
    const rawHandle = raw.is_from_me ? "me" : ext.handle_id || "unknown";
    const displayName = rawHandle === "me" ? undefined : this.contacts.lookupHandle(rawHandle);

    // Parse rich content summary if available.
    //
    // `message_summary_info` is set on many plain-text messages too
    // (delivery receipts / typing-indicator metadata, depending on iOS
    // version). The canonical "this message renders as a rich balloon"
    // marker is `balloon_bundle_id` — only fall back to parsing the
    // summary blob when that is set, otherwise we paint a misleading
    // "[Rich Content]" badge on plain text like "hello world".
    let richContentSummary: string | undefined;
    if (ext.balloon_bundle_id && ext.message_summary_info) {
      richContentSummary = this.parseRichContentSummary(ext.message_summary_info);
    }

    // Unsent detection. `date_retracted` is 0 across the whole DB on current
    // macOS and unsent messages read as `date_edited > 0`, so both raw columns
    // lie. Detect via content-absence (see isUnsentMessage) and let it override
    // the misleading edited flag so an unsent message never shows as "Edited".
    const isUnsent = isUnsentMessage({
      text: cleanText,
      attributedBodyLength: raw.attributedBody?.length ?? 0,
      hasSummaryInfo: Boolean(ext.message_summary_info && ext.message_summary_info.length > 0),
      itemType: ext.item_type ?? 0,
      associatedMessageType: associatedType,
      hasAttachments,
    });

    // iPhone-generated voice-note transcript (iOS 17+), if Apple synced one.
    // Marker-gated inside the extractor, so this is a cheap no-op for non-audio.
    const appleAudioTranscript = extractAudioTranscription(raw.attributedBody ?? null);

    // Edit history for edited messages (parsed from message_summary_info). Only
    // ~502 rows carry this DB-wide, so parsing inline for edited rows is cheap.
    const isEditedMessage = !isUnsent && Boolean(ext.date_edited && ext.date_edited > 0);
    const editHistory =
      isEditedMessage && ext.message_summary_info
        ? (extractEditHistory(ext.message_summary_info) ?? undefined)
        : undefined;

    return {
      id: raw.ROWID,
      guid: raw.guid,
      text: cleanText,
      handle: rawHandle,
      displayName: displayName !== rawHandle ? displayName : undefined,
      isFromMe: Boolean(raw.is_from_me),
      date: macTimestampToDate(raw.date) || new Date(0),
      dateRead: macTimestampToDate(ext.date_read ?? null),
      dateDelivered: macTimestampToDate(ext.date_delivered ?? null),
      isRead: ext.is_read != null ? Boolean(ext.is_read) : true,
      isDelivered: ext.is_delivered != null ? Boolean(ext.is_delivered) : true,
      // Send failure surface: chat.db sets error != 0 (and is_sent = 0) on
      // from-me messages that never went out — e.g. an iMessage attempt to an
      // SMS-only number. Messages.app shows "Not Delivered"; so must we.
      sendError: raw.is_from_me && ext.error ? ext.error : undefined,
      chatId: chatId,
      service: this.detectServiceForMessage(ext) as "iMessage" | "SMS",
      isReaction,
      reaction,
      isReply,
      replyTo,
      reactions,
      richContentType,
      richContentSummary,
      isEdited: isEditedMessage,
      isRetracted: isUnsent || Boolean(ext.date_retracted && ext.date_retracted > 0),
      appleAudioTranscript,
      editHistory,
      hasAttachments,
      attachments,
    };
  }

  /**
   * Consolidate reactions by removing reactions that are canceled by removal messages
   */
  private consolidateReactions(reactions: Reaction[]): Reaction[] {
    const reactionMap = new Map<string, Reaction>();

    for (const r of reactions) {
      const key = `${r.fromHandle}-${r.type}-${r.targetMessagePart}`;
      if (r.isRemoval) {
        reactionMap.delete(key);
      } else {
        reactionMap.set(key, r);
      }
    }

    return Array.from(reactionMap.values());
  }

  /**
   * Detect service from extended message data (handle.service column).
   */
  private detectServiceForMessage(ext: ExtendedMessageData): "iMessage" | "SMS" {
    if (ext.handle_service) {
      return ext.handle_service.toLowerCase().includes("sms") ? "SMS" : "iMessage";
    }
    return "iMessage";
  }

  /**
   * Schedule a non-blocking background refresh of caches.
   * Call after responding to an MCP tool call or TUI refresh.
   */
  scheduleBackgroundRefresh(): void {
    if (this.backgroundRefreshScheduled) return;
    this.backgroundRefreshScheduled = true;
    setImmediate(() => {
      this.backgroundRefreshScheduled = false;
      try {
        // Invalidate caches so the next request gets fresh data
        this.cachedAllChats = null;
        this.cachedLastByChat = null;
        this.cachedUnreadByChat = null;
        this.cachedReactionsByChat.clear();
        // Pre-warm the cache
        this.getAllChatsWithLastDate();
        // Sync any new slugs
        this.scheduleBackgroundSlugSync();
      } catch {
        // Refresh is best-effort; foreground requests will surface real DB errors.
      }
    });
  }

  /** Resolve participant handles to display names via contacts DB. */
  resolveParticipantNames(handles: string[]): string[] {
    return handles.map((h) => this.contacts.lookupHandle(h));
  }

  /**
   * Close database connections
   */
  async close(): Promise<void> {
    this.closed = true;
    this.raw.close();
    this.contacts.close();
    this.slugStore.close();
  }

  /**
   * Fetch extended message data using raw DB
   * Includes: is_read, date_read, handle_id, reaction data, reply data, edit status, attachments
   */
  private fetchExtendedMessageData(rowid: number): ExtendedMessageData {
    const stmt = this.raw.prepare(`
      SELECT 
        m.is_read,
        m.date_read,
        m.is_delivered,
        m.error,
        m.date_delivered,
        h.id as handle_id,
        h.service as handle_service,
        m.associated_message_type,
        m.associated_message_guid,
        m.associated_message_emoji,
        m.thread_originator_guid,
        m.thread_originator_part,
        m.balloon_bundle_id,
        m.item_type,
        m.date_edited,
        m.date_retracted,
        m.cache_has_attachments,
        m.message_summary_info,
        m.payload_data
      FROM ${Tables.MESSAGE} m
      LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
      WHERE m.ROWID = ?
      LIMIT 1
    `);
    return (stmt.get(rowid) as ExtendedMessageData) || {};
  }

  /**
   * Batch-fetch extended message data for multiple ROWIDs in a single query.
   * Falls back to individual fetches for very large batches (SQLite bind param limit).
   */
  private fetchExtendedMessageDataBatch(rowids: number[]): Map<number, ExtendedMessageData> {
    const result = new Map<number, ExtendedMessageData>();
    if (rowids.length === 0) return result;

    const CHUNK = 500;
    for (let i = 0; i < rowids.length; i += CHUNK) {
      const chunk = rowids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = this.raw.prepare(`
        SELECT
          m.ROWID as _rowid,
          m.is_read, m.date_read, m.is_delivered,
        m.error, m.date_delivered,
          h.id as handle_id, h.service as handle_service,
          m.associated_message_type, m.associated_message_guid,
          m.associated_message_emoji, m.thread_originator_guid,
          m.thread_originator_part, m.balloon_bundle_id,
          m.item_type, m.date_edited, m.date_retracted,
          m.cache_has_attachments, m.message_summary_info, m.payload_data
        FROM ${Tables.MESSAGE} m
        LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
        WHERE m.ROWID IN (${placeholders})
      `);
      const rows = stmt.all(...chunk) as (ExtendedMessageData & { _rowid: number })[];
      for (const row of rows) {
        result.set(row._rowid, row);
      }
    }
    return result;
  }

  /**
   * Whether `table` has `column` in the current chat.db schema (cached per table).
   * Guards columns that are absent on older macOS DBs or synthetic fixtures
   * (e.g. `message.is_audio_message`, `attachment.emoji_image_short_description`).
   */
  private hasColumn(table: string, column: string): boolean {
    let cols = this.columnCache.get(table);
    if (!cols) {
      try {
        const rows = this.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        cols = new Set(rows.map((r) => r.name));
      } catch {
        cols = new Set<string>();
      }
      this.columnCache.set(table, cols);
    }
    return cols.has(column);
  }

  /** Max ROWID currently in the message table — used as a cache key. */
  getMaxMessageRowId(): number {
    const row = this.raw
      .prepare(`SELECT COALESCE(MAX(ROWID), 0) AS m FROM ${Tables.MESSAGE}`)
      .get() as { m: number };
    return Number(row.m) || 0;
  }

  /**
   * Fetch every message newer than `cutoffMs` across all chats. Used by the
   * chat_analytics tool — bounded by date, not by per-chat limit. Reactions
   * are included (tapback analytics need them); hidden system items dropped.
   */
  async getMessagesInWindow(cutoffMs: number, capPerWindow = 80_000): Promise<Message[]> {
    const span = perf("getMessagesInWindow");
    const cutoffNanos = Math.floor((cutoffMs / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
    // Fetch the most-recent `capPerWindow` messages in the window (DESC + LIMIT),
    // then hand analytics the ASC slice they expect. Loading the OLDEST N (plain
    // ASC LIMIT) both starved recency-weighted analytics and — at the old 200k
    // cap — materialized ~200k parsed Message objects (~960MB RSS on a large
    // chat.db), which added to the TUI baseline tripped the 1024MB watchdog kill
    // when a user opened an "all"-range analytic. The lower cap keeps the peak
    // bounded; the DESC window keeps a capped load meaningful.
    const sql = `
      SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.date, m.date_read, m.date_delivered,
             m.is_read, m.is_delivered,
        m.error, m.is_from_me, h.id as handle_id,
             h.service as handle_service,
             m.cache_has_attachments, m.associated_message_type,
             m.associated_message_guid, m.associated_message_emoji,
             m.thread_originator_guid, m.thread_originator_part,
             m.balloon_bundle_id, m.message_summary_info,
             m.date_edited, m.date_retracted,
             m.item_type, c.chat_identifier
      FROM ${Tables.MESSAGE} m
      LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
      LEFT JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
      LEFT JOIN ${Tables.CHAT} c ON cmj.chat_id = c.ROWID
      WHERE m.date >= ?
      ORDER BY m.date DESC
      LIMIT ?
    `;
    const rows = (this.raw.prepare(sql).all(cutoffNanos, capPerWindow) as any[]).reverse();
    const out: Message[] = [];
    for (const r of rows) {
      if (isHiddenSystemItem(r.item_type)) continue;
      const text = this.parseMessageText(r);
      // IMPORTANT: ext must carry every field convertMessage uses to
      // classify the row (reaction / edit / reply / service / etc.) —
      // without these, analytics like tapback_summary see every message
      // as a normal text and return 0 reactions.
      const ext: ExtendedMessageData = {
        is_read: r.is_read,
        date_read: r.date_read,
        is_delivered: r.is_delivered,
        date_delivered: r.date_delivered,
        handle_id: r.handle_id,
        handle_service: r.handle_service,
        associated_message_type: r.associated_message_type,
        associated_message_guid: r.associated_message_guid,
        associated_message_emoji: r.associated_message_emoji,
        thread_originator_guid: r.thread_originator_guid,
        thread_originator_part: r.thread_originator_part,
        balloon_bundle_id: r.balloon_bundle_id,
        message_summary_info: r.message_summary_info,
        date_edited: r.date_edited,
        date_retracted: r.date_retracted,
        cache_has_attachments: r.cache_has_attachments,
        item_type: r.item_type,
      };
      const msg = this.convertMessage(r, text, r.chat_identifier || "", ext);
      out.push(msg);
    }
    span.end({ cutoffMs, returned: out.length });
    return out;
  }

  /**
   * Search attachments by MIME prefix, date window, and/or chat identifier.
   * Excludes stickers (is_sticker=1) and Apple plugin-payload UTIs which
   * aren't meaningful as user-facing attachments.
   *
   * Returns metadata only — use getAttachmentByRowId for the file bytes.
   */
  searchAttachments(opts: {
    mimePrefix?: string;
    chatIdentifier?: string;
    sinceMs?: number;
    untilMs?: number;
    limit: number;
  }): Array<{
    rowId: number;
    filename: string;
    mimeType: string | null;
    transferName: string | null;
    totalBytes: number;
    createdDate: Date;
    chatId: string;
  }> {
    const span = perf("searchAttachments");
    const conds: string[] = [
      "a.is_sticker = 0",
      "(a.uti IS NULL OR a.uti NOT LIKE 'com.apple.messages.plugin%')",
    ];
    const params: any[] = [];
    if (opts.mimePrefix) {
      conds.push("a.mime_type LIKE ?");
      params.push(`${opts.mimePrefix}%`);
    }
    if (opts.chatIdentifier) {
      conds.push("c.chat_identifier = ?");
      params.push(opts.chatIdentifier);
    }
    const toMacNanos = (ms: number): number =>
      Math.floor((ms / 1000 - MAC_EPOCH_OFFSET) * NANOS_PER_SECOND);
    if (opts.sinceMs !== undefined) {
      conds.push("a.created_date >= ?");
      params.push(toMacNanos(opts.sinceMs));
    }
    if (opts.untilMs !== undefined) {
      conds.push("a.created_date <= ?");
      params.push(toMacNanos(opts.untilMs));
    }
    const lim = opts.limit > 0 ? opts.limit : 1000;
    params.push(lim);

    const sql = `
      SELECT
        a.ROWID as rowId,
        a.filename,
        a.mime_type,
        a.transfer_name,
        a.total_bytes,
        a.created_date,
        c.chat_identifier
      FROM ${Tables.ATTACHMENT} a
      JOIN ${Tables.MESSAGE_ATTACHMENT_JOIN} maj ON a.ROWID = maj.attachment_id
      JOIN ${Tables.MESSAGE} m ON maj.message_id = m.ROWID
      JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
      JOIN ${Tables.CHAT} c ON cmj.chat_id = c.ROWID
      WHERE ${conds.join(" AND ")}
      ORDER BY a.created_date DESC
      LIMIT ?
    `;
    const rows = this.raw.prepare(sql).all(...params) as any[];
    const out = rows.map((r) => ({
      rowId: Number(r.rowId),
      filename: r.filename || "",
      mimeType: r.mime_type ?? null,
      transferName: r.transfer_name ?? null,
      totalBytes: Number(r.total_bytes) || 0,
      // `attachment.created_date` stores seconds since 2001-01-01,
      // not nanoseconds. The auto-detecting converter handles both
      // legacy seconds-formatted rows and any modern ns-formatted rows
      // that may show up in a heterogeneous DB.
      createdDate: macAutoTimestampToDate(Number(r.created_date)) ?? new Date(0),
      chatId: r.chat_identifier || "",
    }));
    span.end({ count: out.length });
    return out;
  }

  /**
   * All attachments across EVERY merged leg of one conversation (newest first)
   * for the TUI per-thread info drawer. Unlike searchAttachments (single
   * chat_identifier), this resolves the conversation to all its chat ROWIDs
   * (resolveChatsForConversation) so the SMS and iMessage legs of a merged
   * identity are both covered. Excludes stickers and Apple plugin payloads.
   */
  listConversationAttachments(chatIdentifier: string, limit = 500): ConversationAttachment[] {
    const span = perf("listConversationAttachments");
    const chats = this.resolveChatsForConversation(chatIdentifier);
    if (chats.length === 0) {
      span.end({ returned: 0 });
      return [];
    }
    const placeholders = chats.map(() => "?").join(",");
    const lim = limit > 0 ? limit : 500;
    const sql = `
      SELECT DISTINCT
        a.ROWID as rowId,
        a.filename,
        a.mime_type,
        a.transfer_name,
        a.total_bytes,
        a.created_date
      FROM ${Tables.ATTACHMENT} a
      JOIN ${Tables.MESSAGE_ATTACHMENT_JOIN} maj ON a.ROWID = maj.attachment_id
      JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON maj.message_id = cmj.message_id
      WHERE cmj.chat_id IN (${placeholders})
        AND a.is_sticker = 0
        AND (a.uti IS NULL OR a.uti NOT LIKE 'com.apple.messages.plugin%')
      ORDER BY a.created_date DESC
      LIMIT ?
    `;
    const rows = this.raw.prepare(sql).all(...chats.map((c) => c.ROWID), lim) as any[];
    const out = rows.map((r) => ({
      rowId: Number(r.rowId),
      filename: r.filename || "",
      mimeType: r.mime_type ?? null,
      transferName: r.transfer_name ?? null,
      totalBytes: Number(r.total_bytes) || 0,
      createdDate: macAutoTimestampToDate(Number(r.created_date)) ?? new Date(0),
    }));
    span.end({ returned: out.length });
    return out;
  }

  /** Fetch a single attachment record by ROWID. */
  getAttachmentByRowId(rowId: number): {
    rowId: number;
    filename: string;
    mimeType: string | null;
    transferName: string | null;
    totalBytes: number;
  } | null {
    const row = this.raw
      .prepare(
        `SELECT ROWID as rowId, filename, mime_type, transfer_name, total_bytes
         FROM ${Tables.ATTACHMENT}
         WHERE ROWID = ?`,
      )
      .get(rowId) as any;
    if (!row) return null;
    return {
      rowId: Number(row.rowId),
      filename: row.filename || "",
      mimeType: row.mime_type ?? null,
      transferName: row.transfer_name ?? null,
      totalBytes: Number(row.total_bytes) || 0,
    };
  }

  /**
   * Download context for the Stage-7 sync nudge: whether the attachment is
   * marked undownloaded (`transfer_state === -1`) and the identifier of the
   * chat it belongs to (so Tier-1 can open that conversation). LEFT-joins so an
   * attachment with no chat linkage still yields its `transferState`
   * (`chatIdentifier` null). Guards `transfer_state` via `hasColumn` for schema
   * variants that lack it. Returns null when the ROWID is unknown.
   */
  getAttachmentDownloadInfo(
    rowId: number,
  ): { transferState: number | null; chatIdentifier: string | null } | null {
    const transferCol = this.hasColumn("attachment", "transfer_state")
      ? "a.transfer_state as transferState"
      : "NULL as transferState";
    const row = this.raw
      .prepare(
        `SELECT ${transferCol}, c.chat_identifier as chatIdentifier
         FROM ${Tables.ATTACHMENT} a
         LEFT JOIN ${Tables.MESSAGE_ATTACHMENT_JOIN} maj ON a.ROWID = maj.attachment_id
         LEFT JOIN ${Tables.MESSAGE} m ON maj.message_id = m.ROWID
         LEFT JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
         LEFT JOIN ${Tables.CHAT} c ON cmj.chat_id = c.ROWID
         WHERE a.ROWID = ?
         LIMIT 1`,
      )
      .get(rowId) as any;
    if (!row) return null;
    return {
      transferState: row.transferState == null ? null : Number(row.transferState),
      chatIdentifier: row.chatIdentifier || null,
    };
  }

  /**
   * Fetch attachments for a message
   */
  private fetchAttachments(messageRowId: number): Attachment[] {
    const emojiCol = this.hasColumn("attachment", "emoji_image_short_description")
      ? ", a.emoji_image_short_description as emoji_desc"
      : "";
    const stmt = this.raw.prepare(`
      SELECT
        a.ROWID as row_id,
        a.filename,
        a.mime_type,
        a.transfer_name,
        a.total_bytes${emojiCol}
      FROM ${Tables.ATTACHMENT} a
      JOIN ${Tables.MESSAGE_ATTACHMENT_JOIN} maj ON a.ROWID = maj.attachment_id
      WHERE maj.message_id = ?
    `);
    const rows = stmt.all(messageRowId) as any[];
    return rows.map((r) => ({
      rowId: r.row_id,
      filename: r.filename || "",
      mimeType: r.mime_type,
      transferName: r.transfer_name,
      totalBytes: r.total_bytes || 0,
      emojiDescription: r.emoji_desc ?? null,
    }));
  }

  /**
   * Batch-fetch all reactions in a chat, grouped by target message GUID.
   * One query replaces N individual LIKE queries (the main perf bottleneck).
   */
  private fetchReactionsForChat(chatRowId: number): Map<string, Reaction[]> {
    const cached = this.cachedReactionsByChat.get(chatRowId);
    if (cached && Date.now() - cached.ts < IMessageDB.CACHE_TTL_MS) {
      return cached.data;
    }
    const stmt = this.raw.prepare(`
      SELECT
        m.associated_message_type,
        m.associated_message_guid,
        m.associated_message_emoji,
        h.id as handle_id,
        m.is_from_me
      FROM ${Tables.MESSAGE} m
      LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
      JOIN ${Tables.CHAT_MESSAGE_JOIN} cmj ON m.ROWID = cmj.message_id
      WHERE cmj.chat_id = ?
        AND m.associated_message_type >= 2000
    `);

    const rows = stmt.all(chatRowId) as any[];
    const result = new Map<string, Reaction[]>();

    for (const r of rows) {
      const typeInfo = TAPBACK_TYPE_MAP[r.associated_message_type] || {
        type: "unknown" as TapbackType,
        isRemoval: false,
      };
      const parsed = parseAssociatedMessageGuid(r.associated_message_guid);
      const targetGuid = parsed?.targetGuid;
      if (!targetGuid) continue;

      const reaction: Reaction = {
        type: typeInfo.type,
        emoji: r.associated_message_emoji || undefined,
        fromHandle: r.is_from_me ? "me" : r.handle_id || "unknown",
        isRemoval: typeInfo.isRemoval,
        targetMessageGuid: targetGuid,
        targetMessagePart: parsed?.partIndex || 0,
      };

      const existing = result.get(targetGuid);
      if (existing) existing.push(reaction);
      else result.set(targetGuid, [reaction]);
    }

    this.cachedReactionsByChat.set(chatRowId, { data: result, ts: Date.now() });
    return result;
  }

  /**
   * Fetch reactions for a specific message GUID
   */
  private fetchReactionsForMessage(messageGuid: string): Reaction[] {
    const stmt = this.raw.prepare(`
      SELECT 
        m.associated_message_type,
        m.associated_message_guid,
        m.associated_message_emoji,
        h.id as handle_id,
        m.is_from_me
      FROM ${Tables.MESSAGE} m
      LEFT JOIN ${Tables.HANDLE} h ON m.handle_id = h.ROWID
      WHERE m.associated_message_guid LIKE ?
        AND m.associated_message_type >= 2000
    `);

    const rows = stmt.all(`%/${messageGuid}`) as any[];

    return rows.map((r) => {
      const typeInfo = TAPBACK_TYPE_MAP[r.associated_message_type] || {
        type: "unknown" as TapbackType,
        isRemoval: false,
      };
      const parsed = parseAssociatedMessageGuid(r.associated_message_guid);

      return {
        type: typeInfo.type,
        emoji: r.associated_message_emoji || undefined,
        fromHandle: r.is_from_me ? "me" : r.handle_id || "unknown",
        isRemoval: typeInfo.isRemoval,
        targetMessageGuid: parsed?.targetGuid || messageGuid,
        targetMessagePart: parsed?.partIndex || 0,
      };
    });
  }

  /**
   * Parse rich content summary from message_summary_info BLOB
   * This contains metadata about link previews, rich messages, etc.
   */
  private parseRichContentSummary(blob: Buffer | null): string | undefined {
    if (!blob) return undefined;

    try {
      // message_summary_info is a binary plist - try to extract text
      const str = blob.toString("utf8");

      // Look for common patterns in the summary
      // Link URLs
      const urlMatch = str.match(/https?:\/\/\S+/);
      if (urlMatch) {
        return `Link: ${urlMatch[0]}`;
      }

      // Title text (often in plists as <string>Title</string>)
      const titleMatch = str.match(/<string>([^<]+)<\/string>/);
      if (titleMatch) {
        return titleMatch[1];
      }

      // For now, just indicate rich content exists
      return "[Rich Content]";
    } catch {
      return undefined;
    }
  }

  /**
   * Look up the text of a message by GUID (for reply context)
   * Falls back to parsing attributedBody if text is null
   */
  private getMessageTextByRowId(rowId: number): string | null {
    const row = this.raw
      .prepare(`SELECT ROWID, text, attributedBody FROM ${Tables.MESSAGE} WHERE ROWID = ? LIMIT 1`)
      .get(rowId) as
      | { ROWID: number; text: string | null; attributedBody: Buffer | null }
      | undefined;
    return this.extractMessageText(row);
  }

  /**
   * Build reply context for the message being replied to, by GUID. Beyond the
   * plain text, this resolves what KIND of message it was when it carries no text
   * of its own — a voice note (surfacing Apple's transcript), image, video, or
   * file — so the UI renders "↩ voice note: '…'" instead of a bare "(unknown)".
   */
  private getReplyContextByGuid(guid: string): ReplyContext {
    const audioCol = this.hasColumn("message", "is_audio_message")
      ? "is_audio_message"
      : "0 AS is_audio_message";
    const row = this.raw
      .prepare(
        `SELECT ROWID, text, attributedBody, ${audioCol}, cache_has_attachments
         FROM ${Tables.MESSAGE} WHERE guid = ? LIMIT 1`,
      )
      .get(guid) as
      | {
          ROWID: number;
          text: string | null;
          attributedBody: Buffer | null;
          is_audio_message: number | null;
          cache_has_attachments: number | null;
        }
      | undefined;

    const ctx: ReplyContext = { replyToGuid: guid };
    if (!row) return ctx;

    // 1. Voice note: an audio message IS a voice note regardless of any loose
    //    bytes a generic scan might find — surface Apple's synced transcript via
    //    the dedicated extractor and label the kind.
    if (row.is_audio_message) {
      ctx.replyToKind = "voice-note";
      ctx.replyToText = extractAudioTranscription(row.attributedBody) ?? null;
      return ctx;
    }

    // 2. Plain text (or attributedBody text) wins.
    const text = this.extractMessageText(row);
    if (text) {
      ctx.replyToText = text;
      return ctx;
    }

    // 3. Attachment-only: derive kind from the original's first attachment.
    if (row.cache_has_attachments) {
      ctx.replyToKind = this.deriveAttachmentReplyKind(row.ROWID);
      ctx.replyToText = null;
      return ctx;
    }

    ctx.replyToText = null;
    return ctx;
  }

  /** Map a message's first (non-sticker) attachment mime/uti to a reply-kind label. */
  private deriveAttachmentReplyKind(messageRowId: number): "image" | "video" | "file" {
    const utiCol = this.hasColumn("attachment", "uti") ? "a.uti" : "NULL AS uti";
    const row = this.raw
      .prepare(
        `SELECT a.mime_type, ${utiCol}
         FROM ${Tables.ATTACHMENT} a
         JOIN ${Tables.MESSAGE_ATTACHMENT_JOIN} maj ON a.ROWID = maj.attachment_id
         WHERE maj.message_id = ? AND a.is_sticker = 0
         ORDER BY a.ROWID LIMIT 1`,
      )
      .get(messageRowId) as { mime_type: string | null; uti: string | null } | undefined;
    const mime = (row?.mime_type ?? "").toLowerCase();
    const uti = (row?.uti ?? "").toLowerCase();
    if (mime.startsWith("image/") || uti.includes("image")) return "image";
    if (mime.startsWith("video/") || uti.includes("movie") || uti.includes("video")) return "video";
    return "file";
  }

  private extractMessageText(
    row: { ROWID: number; text: string | null; attributedBody: Buffer | null } | undefined,
  ): string | null {
    if (!row) return null;
    if (row.text && !isPlaceholderText(row.text)) return row.text;
    return extractAttributedBodyText(row.attributedBody) || null;
  }
}

/**
 * Extended message data from raw database query
 */
interface ExtendedMessageData {
  is_read?: number;
  date_read?: number;
  is_delivered?: number;
  error?: number;
  date_delivered?: number;
  handle_id?: string | null;
  handle_service?: string | null;
  associated_message_type?: number;
  associated_message_guid?: string | null;
  associated_message_emoji?: string | null;
  thread_originator_guid?: string | null;
  thread_originator_part?: string | null;
  balloon_bundle_id?: string | null;
  item_type?: number;
  date_edited?: number;
  date_retracted?: number;
  cache_has_attachments?: number;
  message_summary_info?: Buffer | null;
  payload_data?: Buffer | null;
}
