/**
 * Central keymap registry.
 *
 * Every action a user can take in the TUI is represented here as a `Command`,
 * even when it's also bound to a key directly inside `App.tsx`'s `useInput`.
 * The palette uses this list both for fuzzy search and (with an empty query)
 * as the complete keybinding cheat sheet.
 *
 * The reducer-level bindings in `App.tsx` still own actual key dispatch — this
 * file is the *description* of those bindings, plus a `run()` that can fire
 * them from the palette.
 */
import type { Dispatch } from "react";
import type { useImsg } from "./hooks/useImsg.js";
import { openSettings } from "./settings-model.js";
import type { Action, AppState } from "./types.js";

export interface CommandContext {
  state: AppState;
  dispatch: Dispatch<Action>;
  imsg: ReturnType<typeof useImsg>;
}

export interface Command {
  /** Stable id ("core.compose", "analytics.streaks"). Used by tests + future keymap config. */
  id: string;
  /** Palette display title. */
  title: string;
  /** Optional dim description shown beside the title. */
  description?: string;
  /** Category for empty-query grouping ("Navigation", "Compose", "Analytics"…). */
  category: string;
  /** Display string for the keybinding column ("c", "Ctrl-d", "gg"). */
  keybinding?: string;
  /** Optional gate — when false the palette omits the entry. */
  when?: (state: AppState) => boolean;
  /** Invoked from the palette. */
  run: (ctx: CommandContext) => void | Promise<void>;
}

const hasSelection = (s: AppState) =>
  s.selectedModuleIdx == null && s.conversations[s.selectedIdx] != null;

/**
 * Core commands. The `run` bodies dispatch the same actions the inline
 * `useInput` handler in App.tsx dispatches. Many keys (movement, etc.) have no
 * sensible `run` from the palette — they're listed here purely so the palette
 * shows them as keybindings. Their `run` is a no-op.
 */
export const CORE_COMMANDS: Command[] = [
  // ── Navigation ─────────────────────────────────────────────────────────
  {
    id: "core.move.down",
    title: "Move down",
    category: "Navigation",
    keybinding: "j / ↓",
    run: () => {},
  },
  {
    id: "core.move.up",
    title: "Move up",
    category: "Navigation",
    keybinding: "k / ↑",
    run: () => {},
  },
  {
    id: "core.move.count",
    title: "Jump N rows",
    category: "Navigation",
    keybinding: "#j / #k",
    description: "Vim-style count prefix",
    run: () => {},
  },
  {
    id: "core.move.top",
    title: "Go to top",
    category: "Navigation",
    keybinding: "gg",
    run: () => {},
  },
  {
    id: "core.move.bottom",
    title: "Go to bottom",
    category: "Navigation",
    keybinding: "G",
    run: () => {},
  },
  {
    id: "core.move.halfdown",
    title: "Half page down",
    category: "Navigation",
    keybinding: "Ctrl-d",
    run: () => {},
  },
  {
    id: "core.move.halfup",
    title: "Half page up",
    category: "Navigation",
    keybinding: "Ctrl-u",
    run: () => {},
  },
  {
    id: "core.move.pagedown",
    title: "Page down",
    category: "Navigation",
    keybinding: "Ctrl-f / PgDn",
    run: () => {},
  },
  {
    id: "core.move.pageup",
    title: "Page up",
    category: "Navigation",
    keybinding: "Ctrl-b / PgUp",
    run: () => {},
  },
  {
    id: "core.move.high",
    title: "First visible row",
    category: "Navigation",
    keybinding: "H",
    run: () => {},
  },
  {
    id: "core.move.middle",
    title: "Middle visible row",
    category: "Navigation",
    keybinding: "M",
    run: () => {},
  },
  {
    id: "core.move.low",
    title: "Last visible row",
    category: "Navigation",
    keybinding: "L",
    run: () => {},
  },
  {
    id: "core.move.groupnext",
    title: "Next sender group",
    category: "Navigation",
    keybinding: "} / ]",
    description: "Jump to next sender boundary",
    run: () => {},
  },
  {
    id: "core.move.groupprev",
    title: "Previous sender group",
    category: "Navigation",
    keybinding: "{ / [",
    run: () => {},
  },
  {
    id: "core.focus.toggle",
    title: "Switch pane (sidebar ↔ thread)",
    category: "Navigation",
    keybinding: "Tab",
    run: ({ state, dispatch }) =>
      dispatch({ type: "FOCUS", pane: state.focus === "sidebar" ? "thread" : "sidebar" }),
  },

  // ── Conversations ──────────────────────────────────────────────────────
  {
    id: "core.filter",
    title: "Filter conversations",
    category: "Conversations",
    keybinding: "/",
    run: ({ dispatch }) => dispatch({ type: "ENTER_FILTER" }),
  },
  {
    id: "core.copy.slug",
    title: "Copy thread slug",
    category: "Conversations",
    keybinding: "y",
    description: "Sidebar focus — copies ~slug to clipboard",
    run: () => {},
  },
  {
    id: "core.refresh",
    title: "Refresh conversations",
    category: "Conversations",
    keybinding: "r",
    run: ({ dispatch }) => dispatch({ type: "SET_STATUS", status: "Refreshing…" }),
  },

  // ── Compose / send ─────────────────────────────────────────────────────
  {
    id: "core.compose",
    title: "Compose in current thread",
    category: "Compose",
    keybinding: "c",
    when: hasSelection,
    run: ({ dispatch }) => dispatch({ type: "ENTER_COMPOSE" }),
  },
  {
    id: "core.compose.new",
    title: "New conversation",
    category: "Compose",
    keybinding: "N",
    description: "Compose to a new recipient",
    run: ({ dispatch }) => dispatch({ type: "ENTER_COMPOSE_NEW" }),
  },
  {
    id: "core.send.via",
    title: "Send via external app",
    category: "Compose",
    keybinding: "S",
    description: "Pick an installed chat app and deep-link to this thread",
    when: hasSelection,
    run: ({ dispatch }) => dispatch({ type: "ENTER_SEND_VIA" }),
  },
  {
    id: "core.open.messages",
    title: "Open in Messages.app",
    category: "Compose",
    keybinding: "O",
    when: hasSelection,
    run: () => {},
  },

  // ── Thread actions ─────────────────────────────────────────────────────
  {
    id: "core.details",
    title: "Open message details drawer",
    category: "Thread",
    keybinding: "Enter",
    run: ({ dispatch }) => dispatch({ type: "OPEN_DRAWER" }),
  },
  {
    id: "core.thread-info",
    title: "Thread info & attachments drawer",
    description: "Metadata + browse/export all attachments in the thread",
    category: "Thread",
    keybinding: "i",
    when: hasSelection,
    run: ({ state, dispatch, imsg }) => {
      const conv = state.conversations[state.selectedIdx];
      if (!conv) return;
      const stats = imsg.getChatStats(conv.chatIdentifier);
      const attachments = imsg.listConversationAttachments(conv.chatIdentifier);
      dispatch({ type: "OPEN_INFO_DRAWER", stats, attachments });
    },
  },
  {
    id: "core.attachment.open",
    title: "Open attachment",
    category: "Thread",
    keybinding: "o",
    description: "Images → Quick Look, video → mpv",
    run: () => {},
  },
  {
    id: "core.attachment.interpret",
    title: "Interpret voice note / media",
    category: "Thread",
    keybinding: "R",
    description:
      "Transcribe a voice note or caption an image/video (on-device or configured cloud)",
    run: () => {},
  },
  {
    id: "core.select.start",
    title: "Visual select messages",
    category: "Thread",
    keybinding: "V",
    run: ({ dispatch }) => dispatch({ type: "ENTER_SELECT_MODE" }),
  },
  {
    id: "core.date.jump",
    title: "Jump to date",
    category: "Thread",
    keybinding: ":",
    run: ({ dispatch }) => dispatch({ type: "ENTER_DATE_JUMP" }),
  },
  {
    id: "core.copy.text",
    title: "Copy selected messages",
    category: "Thread",
    keybinding: "y",
    description: "Visual select mode — copies text to clipboard",
    run: () => {},
  },
  {
    id: "core.export",
    title: "Export selection / thread",
    category: "Thread",
    keybinding: "e",
    description: "From visual select mode",
    run: () => {},
  },

  // ── App ────────────────────────────────────────────────────────────────
  {
    id: "core.devstats",
    title: "Toggle dev stats",
    category: "App",
    keybinding: "d",
    description: "Engine, perf, memory",
    run: ({ dispatch }) => dispatch({ type: "TOGGLE_DEV_STATS" }),
  },
  {
    id: "core.palette",
    title: "Command palette",
    category: "App",
    keybinding: "Ctrl-P / ?",
    description: "This window",
    run: ({ dispatch }) => dispatch({ type: "OPEN_PALETTE" }),
  },
  {
    id: "core.settings",
    title: "Settings — media interpretation",
    category: "App",
    keybinding: ",",
    description: "Chains, toggles, providers",
    run: ({ dispatch }) => openSettings(dispatch),
  },
  { id: "core.quit", title: "Quit", category: "App", keybinding: "q / Ctrl-C", run: () => {} },
];
