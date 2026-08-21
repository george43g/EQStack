/**
 * Inline group-event rows for the thread pane (#106 follow-up).
 *
 * Events are NEVER merged into the messages array. The pane's cursor,
 * bounded-memory eviction, lazy-load prepend, and pagination are all
 * index/ROWID-based over `messages`; injecting pseudo-rows would ripple
 * through every one of them (that interaction is exactly why inline rows
 * were deferred from #106). Instead events are placed at render time as
 * cursor-inert annotation rows — the same class as date separators and
 * eviction gap markers, which already interleave this way.
 *
 * Placement is by ROWID, not date: group-system events are rows of the same
 * `message` table (item_type 1/2/3), so `event.id` and `message.id` share
 * one monotonic ROWID space and "between message A and B" is exact.
 */
import type { ConversationEvent } from "../types.js";

export interface EvictionGap {
  atIdx: number;
  oldestId: number;
  newestId: number;
  count: number;
}

/**
 * Place events between loaded messages.
 *
 * Returns a map keyed by the message index each event renders BEFORE;
 * key === messages.length means "after the newest message" (a rename that is
 * the thread's latest activity still shows).
 *
 * Dropped, deliberately:
 * - events older than the oldest LOADED message (key would be 0): they belong
 *   to the not-yet-loaded region and appear automatically once scroll-back
 *   prepends it — rendering them all pinned to the top would misplace them;
 * - events inside an evicted gap: the gap marker already says the region is
 *   elided, and its events reload with it.
 */
export function placeEventRows(
  messages: ReadonlyArray<{ id: number }>,
  events: readonly ConversationEvent[],
  gaps: readonly EvictionGap[] = [],
): Map<number, ConversationEvent[]> {
  const placed = new Map<number, ConversationEvent[]>();
  if (messages.length === 0 || events.length === 0) return placed;

  const inGap = (id: number): boolean => gaps.some((g) => id >= g.oldestId && id <= g.newestId);

  const sorted = [...events].sort((a, b) => a.id - b.id);
  for (const ev of sorted) {
    if (ev.id < messages[0].id) continue; // before the loaded window
    if (inGap(ev.id)) continue;
    // First loaded message with a higher ROWID; none → tail.
    let idx = messages.findIndex((m) => m.id > ev.id);
    if (idx === 0) continue; // defensive: equivalent to the older-than-window case
    if (idx < 0) idx = messages.length;
    const bucket = placed.get(idx);
    if (bucket) bucket.push(ev);
    else placed.set(idx, [ev]);
  }
  return placed;
}

// Canonical copy now lives in CORE (src/conversation-event-format.ts) since
// the `get_conversation_events` MCP tool shares it; re-exported here so the
// pane, drawer, and their tests keep importing from the TUI layer.
export { formatConversationEvent } from "../conversation-event-format.js";
