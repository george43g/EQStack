/**
 * Synthesized display names for unnamed group chats.
 *
 * Many real group chats have no `chat.display_name`, and every frontend fell
 * back to the raw `chat_identifier` — so the sidebar, thread header, and MCP
 * `list_conversations` all showed opaque ids like `chat926244..`. Messages.app
 * never does this: it titles unnamed groups from the members. This module is
 * the core-side equivalent (architecture rule: interpretation lives in core;
 * frontends only render).
 *
 * Pure functions — the caller resolves handles to contact names.
 */

/** Max member names shown before collapsing the rest into "+N". */
const MAX_SHOWN = 3;

/**
 * First word of a resolved contact name ("Isabella Smith" → "Isabella").
 * Handles that did not resolve stay whole — a phone number or email is
 * itself information, and splitting it would mangle it.
 */
export function groupMemberLabel(handle: string, resolved: string): string {
  if (resolved === handle) return handle;
  return resolved.trim().split(/\s+/)[0] || handle;
}

/**
 * Build a group title from member labels: "Alice, Bob, Cara +2".
 * Dedupes case-insensitively (one contact can appear via two handles),
 * drops blanks, returns null when there is nothing to show so callers
 * keep their existing fallback chain.
 */
export function formatGroupName(labels: string[]): string | null {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  if (unique.length === 0) return null;
  const shown = unique.slice(0, MAX_SHOWN);
  const rest = unique.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

/**
 * Convenience composition used by the DB layer: resolve every participant
 * through `resolve` (contact lookup; returns the handle itself on miss) and
 * format the result.
 */
export function synthesizeGroupName(
  participants: string[],
  resolve: (handle: string) => string,
): string | null {
  return formatGroupName(participants.map((h) => groupMemberLabel(h, resolve(h))));
}
