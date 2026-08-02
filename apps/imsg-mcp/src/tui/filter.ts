/**
 * Shared conversation-filter predicate. Used by Sidebar (rendering) and
 * App.tsx (Enter-to-jump-to-first-match handler).
 */
import type { Conversation } from "../types.js";

export function matchesConversationFilter(c: Conversation, queryLower: string): boolean {
  return (
    (c.displayName?.toLowerCase().includes(queryLower) ?? false) ||
    c.chatIdentifier.toLowerCase().includes(queryLower) ||
    c.threadSlug.toLowerCase().includes(queryLower)
  );
}

/**
 * Return the index of the first conversation matching `query` in the full
 * conversations array, or null if no match. Index is a position into the
 * ORIGINAL conversations array — not the filtered view — so it can be passed
 * to a SELECT action directly.
 */
export function firstFilterMatchIndex(conversations: Conversation[], query: string): number | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const q = trimmed.toLowerCase();
  for (let i = 0; i < conversations.length; i++) {
    if (matchesConversationFilter(conversations[i]!, q)) return i;
  }
  return null;
}

/**
 * Indices (into the ORIGINAL conversations array) of every row matching
 * `query`, in order. An empty query yields every index — mirroring the Sidebar,
 * which renders the full list unfiltered when the query is blank. This is the
 * ordered set the in-filter cursor walks, so `matches[filterCursor]` maps a
 * filtered position back to a real conversation index for SELECT/loadMessages.
 */
export function filterMatchIndices(conversations: Conversation[], query: string): number[] {
  const q = query.toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < conversations.length; i++) {
    if (!q || matchesConversationFilter(conversations[i]!, q)) out.push(i);
  }
  return out;
}
