/**
 * Sender-group boundaries — the domain knowledge behind `{`/`}` jumps.
 *
 * Moved out of ThreadPane so the reducer can hand them to tui-kit
 * `navReduce` as `ctx.groupBoundary` (group semantics are the caller's per
 * the kit contract; a sender flip is imsg's definition). ThreadPane
 * re-exports for its own render-time grouping and for existing importers.
 */
import type { Message } from "../types.js";

/**
 * Find the index of the next sender-group boundary from the given position.
 * A group boundary is where the sender changes (isFromMe flips or handle changes).
 */
export function nextGroupBoundary(messages: Message[], fromIdx: number): number {
  if (fromIdx >= messages.length - 1) return messages.length - 1;
  const current = messages[fromIdx];
  // Skip to end of current group
  let i = fromIdx + 1;
  while (i < messages.length) {
    const m = messages[i];
    if (m.isFromMe !== current.isFromMe || m.handle !== current.handle) {
      return i;
    }
    i++;
  }
  return messages.length - 1;
}

/**
 * Find the index of the previous sender-group boundary from the given position.
 */
export function prevGroupBoundary(messages: Message[], fromIdx: number): number {
  if (fromIdx <= 0) return 0;
  const current = messages[fromIdx];
  // If we're at the start of a group, go to start of previous group
  const prev = messages[fromIdx - 1];
  if (prev.isFromMe !== current.isFromMe || prev.handle !== current.handle) {
    // We're at a boundary — find start of previous group
    let i = fromIdx - 1;
    while (i > 0) {
      const m = messages[i - 1];
      if (m.isFromMe !== prev.isFromMe || m.handle !== prev.handle) {
        return i;
      }
      i--;
    }
    return 0;
  }
  // We're in the middle of a group — go to start of current group
  let i = fromIdx - 1;
  while (i > 0) {
    const m = messages[i - 1];
    if (m.isFromMe !== current.isFromMe || m.handle !== current.handle) {
      return i;
    }
    i--;
  }
  return 0;
}
