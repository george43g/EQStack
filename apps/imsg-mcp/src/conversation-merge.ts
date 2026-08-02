/**
 * Pure conversation-merge logic for listConversations. One human conversation
 * often spans multiple chat rows (phone vs email, SMS vs iMessage legs) that
 * share a merge key (see IMessageDB.getConversationMergeKey and
 * docs/CONTACT_MERGE_AND_SLUGS.md). Extracted from IMessageDB: these
 * functions only read their arguments — no DB access, no caches — so the
 * preference cascade is directly unit-testable.
 */
import type { Conversation } from "./types.js";

/** The one field the merge cascade reads from the last-message row. */
export interface MergeableLast {
  lastService: string | null;
}

export type PreparedConversationEntry<L extends MergeableLast = MergeableLast> = {
  last?: L;
  mergeKey: string;
  conversation: Conversation;
};

/** Collapse entries that share a merge key, preserving first-seen order. */
export function mergeDuplicateConversations<L extends MergeableLast>(
  prepared: PreparedConversationEntry<L>[],
): PreparedConversationEntry<L>[] {
  const merged: typeof prepared = [];
  const indexByKey = new Map<string, number>();

  for (const entry of prepared) {
    const existingIndex = indexByKey.get(entry.mergeKey);
    if (existingIndex === undefined) {
      indexByKey.set(entry.mergeKey, merged.length);
      merged.push(entry);
      continue;
    }

    merged[existingIndex] = mergeConversationEntries(merged[existingIndex], entry);
  }

  return merged;
}

export function mergeConversationEntries<L extends MergeableLast>(
  left: PreparedConversationEntry<L>,
  right: PreparedConversationEntry<L>,
): PreparedConversationEntry<L> {
  const preferred = pickPreferredConversationEntry(left, right);
  const other = preferred === left ? right : left;
  const sameIdentifier =
    preferred.conversation.chatIdentifier === other.conversation.chatIdentifier;

  return {
    mergeKey: preferred.mergeKey,
    last: preferred.last ?? other.last,
    conversation: {
      ...preferred.conversation,
      displayName: preferred.conversation.displayName ?? other.conversation.displayName,
      participants: [
        ...new Set([...preferred.conversation.participants, ...other.conversation.participants]),
      ],
      unreadCount: sameIdentifier
        ? Math.max(preferred.conversation.unreadCount, other.conversation.unreadCount)
        : preferred.conversation.unreadCount + other.conversation.unreadCount,
    },
  };
}

/**
 * Preference cascade for which leg represents the merged conversation:
 * newer lastMessageDate → serviceType matching the last message's real
 * service → displayName presence → iMessage over SMS → left.
 */
export function pickPreferredConversationEntry<L extends MergeableLast>(
  left: PreparedConversationEntry<L>,
  right: PreparedConversationEntry<L>,
): PreparedConversationEntry<L> {
  const leftTime = left.conversation.lastMessageDate?.getTime() ?? 0;
  const rightTime = right.conversation.lastMessageDate?.getTime() ?? 0;
  if (leftTime !== rightTime) {
    return leftTime > rightTime ? left : right;
  }

  const preferredService = left.last?.lastService ?? right.last?.lastService ?? null;
  if (preferredService) {
    const preferredType = preferredService.toLowerCase().includes("sms") ? "SMS" : "iMessage";
    if (
      left.conversation.serviceType === preferredType &&
      right.conversation.serviceType !== preferredType
    ) {
      return left;
    }
    if (
      right.conversation.serviceType === preferredType &&
      left.conversation.serviceType !== preferredType
    ) {
      return right;
    }
  }

  if (left.conversation.displayName && !right.conversation.displayName) return left;
  if (right.conversation.displayName && !left.conversation.displayName) return right;

  if (left.conversation.serviceType === "iMessage" && right.conversation.serviceType === "SMS") {
    return left;
  }
  if (right.conversation.serviceType === "iMessage" && left.conversation.serviceType === "SMS") {
    return right;
  }

  return left;
}
