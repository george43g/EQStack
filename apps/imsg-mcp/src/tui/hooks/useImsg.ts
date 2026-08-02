import { useCallback, useRef } from "react";
import {
  type SendService,
  sendMessageReliable,
  sendToChat,
  sendToChatId,
} from "../../applescript.js";
import { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } from "../../config.js";
import { IMessageDB } from "../../imessage-db.js";
import { applyInlineInterpretations } from "../../media-intel-runtime.js";
import {
  defaultCountryFromEnv,
  type RecipientResolution,
  resolveRecipient,
} from "../../recipient.js";
import { type Conversation, type Message, minMessageId } from "../../types.js";
import { getCached, isFresh, prependCached, setCached } from "../messageCache.js";

export function useImsg() {
  const dbRef = useRef<IMessageDB | null>(null);

  const getDb = useCallback(() => {
    if (!dbRef.current) {
      dbRef.current = new IMessageDB(getImsgDbPath(), getContactsDbPaths(), getSlugsDbPath());
    }
    return dbRef.current;
  }, []);

  const loadConversations = useCallback(
    async (limit = 200): Promise<Conversation[]> => {
      return getDb().listConversations(limit);
    },
    [getDb],
  );

  const loadMessages = useCallback(
    async (chatIdentifier: string): Promise<Message[]> => {
      // Read-through cache: return fresh entries directly without hitting the DB.
      const cached = getCached(chatIdentifier);
      if (cached && isFresh(cached)) return cached.messages;

      const messages = await getDb().getMessagesForChat(chatIdentifier, 200, {
        includeReactionDetails: true,
      });
      // Inline cached/instant transcripts + captions before caching (peek only —
      // never blocks on a cloud call).
      applyInlineInterpretations(messages);
      const oldestId = minMessageId(messages) ?? 0;
      setCached(chatIdentifier, messages, oldestId);
      return messages;
    },
    [getDb],
  );

  const loadOlderMessages = useCallback(
    async (chatIdentifier: string, beforeMessageId: number): Promise<Message[]> => {
      const older = await getDb().getMessagesForChat(chatIdentifier, 100, {
        includeReactionDetails: true,
        beforeMessageId,
      });
      applyInlineInterpretations(older);
      // Merge into cache so subsequent re-entries see the full loaded history.
      if (older.length > 0) prependCached(chatIdentifier, older);
      return older;
    },
    [getDb],
  );

  /**
   * Load every message newer than the given Date — used by analytics panes
   * that compute over a time window rather than a single thread.
   */
  const loadMessagesInWindow = useCallback(
    async (since: Date): Promise<Message[]> => {
      return getDb().getMessagesInWindow(since.getTime());
    },
    [getDb],
  );

  const resolveNames = useCallback(
    (handles: string[]): string[] => {
      return getDb().resolveParticipantNames(handles);
    },
    [getDb],
  );

  /** Message count + first/last date for a conversation (per-thread info drawer). */
  const getChatStats = useCallback(
    (chatIdentifier: string) => getDb().getChatStats(chatIdentifier),
    [getDb],
  );

  /** All attachments across every merged leg of a conversation, newest first. */
  const listConversationAttachments = useCallback(
    (chatIdentifier: string) => getDb().listConversationAttachments(chatIdentifier),
    [getDb],
  );

  const send = useCallback(
    async (threadSlug: string, text: string): Promise<{ success: boolean; error?: string }> => {
      const db = getDb();
      const slugRecord = db.getSlugRecord(threadSlug);
      if (!slugRecord) return { success: false, error: `Unknown slug: ${threadSlug}` };

      if (slugRecord.isGroup) {
        return slugRecord.displayName && !slugRecord.displayName.startsWith("chat")
          ? sendToChat(slugRecord.displayName, text)
          : sendToChatId(slugRecord.chatGuid, text);
      }
      // Route on the thread's REAL service. AppleScript cannot detect a
      // wrong-service send (lazy participant resolution): an iMessage-first
      // attempt to an SMS-only number "succeeds", never delivers (error 22 in
      // chat.db), and mints a phantom iMessage chat leg. The slug store knows
      // which service the conversation actually lives on — send there first.
      const preferred: SendService =
        db.getPreferredSendService(slugRecord.chatIdentifier) ??
        (slugRecord.service === "SMS" ? "SMS" : "iMessage");
      return sendMessageReliable(slugRecord.chatIdentifier, text, preferred);
    },
    [getDb],
  );

  /**
   * Resolve a free-form recipient (E.164 / local phone / iMessage email /
   * contact name) without sending — used by ComposeRecipientModal to validate
   * input as the user types and to surface ambiguous-contact candidates.
   */
  const resolveRecipientInput = useCallback(
    (input: string): RecipientResolution => {
      const db = getDb();
      return resolveRecipient(input, {
        contacts: db.contacts,
        defaultCountry: defaultCountryFromEnv(),
      });
    },
    [getDb],
  );

  /**
   * Send to an arbitrary recipient (not tied to an existing thread slug).
   * Runs the same `resolveRecipient` normalizer as the MCP path, so any of
   * the 4 input shapes work: E.164 phone, local phone, iMessage email,
   * unique contact name. Returns an error result for ambiguous matches —
   * caller should disambiguate before calling.
   */
  const sendToRecipient = useCallback(
    async (input: string, text: string): Promise<{ success: boolean; error?: string }> => {
      const resolution = resolveRecipientInput(input);
      if (resolution.kind === "error") return { success: false, error: resolution.message };
      if (resolution.kind === "ambiguous") {
        return {
          success: false,
          error: `Ambiguous: ${resolution.candidates.length} matches for "${input}". Pick a specific handle.`,
        };
      }
      // Existing conversation knows its real service (see `send` above);
      // brand-new recipients default to iMessage-first with SMS fallback.
      const db = getDb();
      const conv = await db.findChatByHandle(resolution.handle);
      const preferred: SendService | undefined =
        conv && !conv.isGroupChat
          ? (db.getPreferredSendService(conv.chatIdentifier) ??
            (conv.serviceType === "SMS" ? "SMS" : "iMessage"))
          : undefined;
      return sendMessageReliable(resolution.handle, text, preferred);
    },
    [resolveRecipientInput, getDb],
  );

  const refresh = useCallback(() => {
    getDb().scheduleBackgroundRefresh();
  }, [getDb]);

  const close = useCallback(async () => {
    if (dbRef.current) {
      await dbRef.current.close();
      dbRef.current = null;
    }
  }, []);

  return {
    loadConversations,
    loadMessages,
    loadOlderMessages,
    loadMessagesInWindow,
    resolveNames,
    getChatStats,
    listConversationAttachments,
    send,
    sendToRecipient,
    resolveRecipientInput,
    refresh,
    close,
  };
}
