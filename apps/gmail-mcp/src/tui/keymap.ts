// Default normal-mode key bindings. `keymapOverrides` from
// ~/.gmail-mcp/config.json (Phase D Session 3) merges on top.

export interface KeyBinding {
  /** Single-char or two-char sequence. */
  keys: string;
  /** Internal command id. */
  cmd: string;
  /** One-line description shown in the help overlay. */
  desc: string;
}

export const defaultBindings: KeyBinding[] = [
  { keys: "j", cmd: "cursor.down", desc: "Cursor down" },
  { keys: "k", cmd: "cursor.up", desc: "Cursor up" },
  { keys: "gg", cmd: "cursor.top", desc: "Top of list" },
  { keys: "G", cmd: "cursor.bottom", desc: "Bottom of list" },
  { keys: "h", cmd: "pane.close", desc: "Collapse current pane" },
  { keys: "l", cmd: "pane.open", desc: "Open / focus next pane" },
  { keys: "Enter", cmd: "pane.open", desc: "Open selected thread / message" },
  { keys: "q", cmd: "pane.close", desc: "Close current pane" },
  { keys: "Q", cmd: "app.quit", desc: "Quit application" },
  { keys: "r", cmd: "msg.reply", desc: "Reply to selected message (editor)" },
  { keys: "R", cmd: "msg.reply-all", desc: "Reply-all to selected message (editor)" },
  { keys: "c", cmd: "msg.compose", desc: "Compose new email (editor)" },
  { keys: "e", cmd: "msg.draft.edit", desc: "Edit selected draft (editor)" },
  { keys: "x", cmd: "msg.delete", desc: "Delete selected (confirm)" },
  { keys: "s", cmd: "msg.star", desc: "Star / unstar selected" },
  { keys: "m", cmd: "msg.read", desc: "Mark read / unread" },
  { keys: "/", cmd: "ui.search", desc: "Open search bar" },
  { keys: ":", cmd: "ui.command", desc: "Open command palette" },
  { keys: "?", cmd: "ui.help", desc: "Toggle help overlay" },
  { keys: "~", cmd: "ui.stats", desc: "Toggle dev stats modal" },
  { keys: "Tab", cmd: "pane.cycle", desc: "Cycle focus across panes" },
];

/** Resolve a key (possibly with buffered prefix) to a command id, or null. */
export function resolveKey(buffer: string, key: string): { cmd: string | null; pending: boolean } {
  const combined = buffer + key;
  // Exact match wins
  const exact = defaultBindings.find((b) => b.keys === combined);
  if (exact) return { cmd: exact.cmd, pending: false };
  // Prefix match → keep buffering
  const isPrefix = defaultBindings.some((b) => b.keys.startsWith(combined) && b.keys !== combined);
  if (isPrefix) return { cmd: null, pending: true };
  // No match — try the raw single key (drop buffer)
  const single = defaultBindings.find((b) => b.keys === key);
  return { cmd: single?.cmd ?? null, pending: false };
}
