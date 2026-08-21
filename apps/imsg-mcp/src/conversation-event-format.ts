/**
 * Human rendering of group-system events (item_type 1/2/3) — CORE, so the
 * MCP handler, CLI, and TUI share one copy (frontends only render). Moved
 * here from the TUI when `get_conversation_events` joined the tool surface;
 * `src/tui/thread-event-rows.ts` re-exports it for the pane and drawer.
 */
import type { ConversationEvent } from "./types.js";

/**
 * One-line rendering. First names keep narrow surfaces readable; the actor
 * falls back to the raw handle, and a null actor is the user.
 *
 * `renderName` lets a caller transform the ONE user-controlled free-text
 * field — the new group title on `renamed` — e.g. the MCP text path wraps it
 * in `<untrusted>` (a group title is exactly as attacker-controlled as a
 * message body). Handles and address-book names pass through untransformed,
 * matching every other tool surface.
 */
export function formatConversationEvent(
  ev: ConversationEvent,
  renderName: (newName: string) => string = (n) => n,
): string {
  const first = (name: string | null, handle: string | null): string => {
    const label = name ?? handle;
    if (!label) return "You";
    return label === handle ? label : (label.trim().split(/\s+/)[0] ?? label);
  };
  const actor = ev.actor === null ? "You" : first(ev.actorName, ev.actor);
  switch (ev.kind) {
    case "renamed":
      return `${actor} renamed to “${ev.newName ? renderName(ev.newName) : "?"}”`;
    case "left":
      return `${actor} left`;
    case "member_added":
      return `${actor} added ${first(ev.targetName, ev.target)}`;
    case "member_removed":
      return `${actor} removed ${first(ev.targetName, ev.target)}`;
  }
}
