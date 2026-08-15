import type { InterpretConfigInput } from "../app-config.js";
import {
  type ChatStats,
  type Conversation,
  type ConversationAttachment,
  type ConversationEvent,
  type Message,
  oldestMessageCursor,
  type Reaction,
} from "../types.js";
import { filterMatchIndices } from "./filter.js";
import type { ModuleInstance } from "./modules/types.js";

export type FocusPane = "sidebar" | "thread";
export type Mode =
  | "browse"
  | "compose"
  | "compose-new"
  | "confirm"
  | "filter"
  | "drawer"
  | "info"
  | "select"
  | "export"
  | "date-jump"
  | "send-via"
  | "settings"
  | "palette";

export interface PendingMessage {
  text: string;
  sentAt: Date;
  status: "sending" | "sent" | "failed";
}

/**
 * Live-stream sidebar patch for one conversation row (keyed by the
 * per-identity threadSlug — every merged leg of a thread shares it).
 */
export interface ConversationTouch {
  threadSlug: string;
  /** New snippet, or null to keep the row's current one. */
  snippet: string | null;
  lastMessageDate: Date;
  /** How much to bump unreadCount by (0 for from-me / active-thread rows). */
  unreadDelta: number;
}

export interface AppState {
  conversations: Conversation[];
  messages: Message[];
  selectedIdx: number;
  selectedMsgIdx: number; // cursor position in messages list
  focus: FocusPane;
  mode: Mode;
  sidebarScroll: number;
  threadScroll: number;
  composeText: string;
  filterQuery: string;
  /** Cursor into the FILTERED result set (filter mode only); 0-based. */
  filterCursor: number;
  /** selectedIdx at the moment `/` was pressed, so Escape can restore it.
   *  null when not filtering (or after a committed filter). */
  filterReturnIdx: number | null;
  /** sidebarScroll at the moment `/` was pressed — restored alongside the index. */
  filterReturnScroll: number;
  pending: PendingMessage[];
  loading: boolean;
  status: string;
  numBuffer: string;
  /** Selected attachment within the drawer's attachment list. */
  drawerAttachmentIdx: number; // for vim-style number prefix (e.g. "12j")
  showDevStats: boolean;

  // Per-thread info/attachment drawer (mode: "info")
  infoStats: ChatStats | null; // message count + date range for the open thread
  infoEvents: ConversationEvent[]; // recent group renames/joins/leaves (groups only)
  infoAttachments: ConversationAttachment[]; // ALL attachments in the thread (merged legs)
  infoAttachmentIdx: number; // cursor within infoAttachments

  // Lazy-loading bookkeeping
  conversationLoadedCount: number; // how many we've requested from the DB so far
  conversationLoadingMore: boolean; // true while a "load more" fetch is in-flight
  messageOldestLoadedId: number | null; // oldest message ROWID currently in `messages` (for "load older")
  messageLoadingOlder: boolean; // true while a "load older" fetch is in-flight

  // Bounded message window — gaps appear when middle of history is evicted
  gapMarkers: Array<{ atIdx: number; oldestId: number; newestId: number; count: number }>;

  // Visual selection (vim V)
  selectionAnchor: number | null; // where the user pressed V — selection extends from anchor to selectedMsgIdx

  // Export modal state
  exportFormat: "markdown" | "csv" | "json";
  exportPath: string;
  exportStatus: string; // last export status message (e.g. "Exported 247 msgs")

  // Date-jump modal state
  dateJumpInput: string;
  dateJumpError: string;

  // Module instances rendered as virtual rows at the top of the sidebar.
  // The sidebar cursor traverses [...moduleInstances, ...conversations].
  moduleInstances: ModuleInstance[];
  /** Index into `moduleInstances` when a virtual row is selected; null when a real conversation is selected. */
  selectedModuleIdx: number | null;

  // Command palette state
  paletteQuery: string;
  paletteCursor: number;

  // Settings panel (mode: "settings") — the editable `interpret` block plus the
  // provider key-presence map (never the keys themselves). null until opened.
  settingsInterpret: InterpretConfigInput | null;
  settingsKeyPresence: Record<string, boolean>;
  settingsCursor: number;
  /** File the panel persists edits to. */
  settingsConfigPath: string;
  settingsWarnings: string[];
}

export type Action =
  | { type: "SET_CONVERSATIONS"; data: Conversation[] }
  | { type: "SET_MESSAGES"; data: Message[] }
  | {
      type: "SET_MESSAGE_INTERPRET";
      msgId: number;
      interpretedMedia: { kind: "audio" | "image" | "video"; text: string; source: string };
    }
  | { type: "SELECT"; index: number; visibleCount?: number }
  | { type: "SELECT_MSG"; index: number }
  | { type: "SELECT_MSG_BY_DATE"; date: Date }
  | { type: "MOVE_MSG"; delta: number }
  | { type: "FOCUS"; pane: FocusPane }
  | { type: "SCROLL_SIDEBAR"; delta: number }
  | { type: "SCROLL_THREAD"; delta: number }
  | { type: "SCROLL_THREAD_TO"; position: number }
  | { type: "ENTER_COMPOSE" }
  | { type: "UPDATE_COMPOSE"; text: string }
  | { type: "CONFIRM_SEND" }
  | { type: "CANCEL_COMPOSE" }
  | { type: "ADD_PENDING"; msg: PendingMessage }
  | { type: "RESOLVE_PENDING"; text: string }
  | { type: "FAIL_PENDING"; text: string }
  | { type: "SET_LOADING"; loading: boolean; status?: string }
  | { type: "SET_STATUS"; status: string }
  | { type: "ENTER_FILTER" }
  | { type: "UPDATE_FILTER"; query: string }
  | { type: "FILTER_MOVE"; delta: number; visibleCount?: number }
  /** `restoreSelection: true` = cancelled (Escape); false = committed (Enter). */
  | { type: "EXIT_FILTER"; restoreSelection: boolean }
  | { type: "OPEN_DRAWER" }
  | { type: "CLOSE_DRAWER" }
  | { type: "SET_DRAWER_ATTACHMENT"; index: number }
  | {
      type: "OPEN_INFO_DRAWER";
      stats: ChatStats;
      attachments: ConversationAttachment[];
      events: ConversationEvent[];
    }
  | { type: "CLOSE_INFO_DRAWER" }
  | { type: "SET_INFO_ATTACHMENT"; index: number }
  | { type: "SET_NUM_BUFFER"; value: string }
  | { type: "TOGGLE_DEV_STATS" }
  | { type: "APPEND_CONVERSATIONS"; data: Conversation[]; loadedCount: number }
  | { type: "PREPEND_MESSAGES"; data: Message[]; oldestId: number }
  | { type: "APPEND_LIVE_MESSAGES"; data: Message[] }
  | { type: "APPLY_LIVE_REACTIONS"; reactions: Reaction[] }
  | { type: "TOUCH_CONVERSATIONS"; touches: ConversationTouch[] }
  | { type: "SET_LOADING_OLDER"; loading: boolean }
  | { type: "ENTER_SELECT_MODE" }
  | { type: "EXIT_SELECT_MODE" }
  | { type: "ENTER_EXPORT_MODE"; defaultPath: string }
  | { type: "EXIT_EXPORT_MODE" }
  | { type: "SET_EXPORT_FORMAT"; format: "markdown" | "csv" | "json" }
  | { type: "SET_EXPORT_PATH"; path: string }
  | { type: "SET_EXPORT_STATUS"; status: string }
  | { type: "ENTER_DATE_JUMP" }
  | { type: "EXIT_DATE_JUMP" }
  | { type: "ENTER_SEND_VIA" }
  | { type: "EXIT_SEND_VIA" }
  | { type: "ENTER_COMPOSE_NEW" }
  | { type: "EXIT_COMPOSE_NEW" }
  | { type: "SET_DATE_JUMP_INPUT"; value: string }
  | { type: "SET_DATE_JUMP_ERROR"; error: string }
  | { type: "OPEN_PALETTE" }
  | { type: "CLOSE_PALETTE" }
  | { type: "SET_PALETTE_QUERY"; query: string }
  | { type: "MOVE_PALETTE_CURSOR"; delta: number }
  | { type: "SET_PALETTE_CURSOR"; index: number }
  | {
      type: "OPEN_SETTINGS";
      interpret: InterpretConfigInput;
      keyPresence: Record<string, boolean>;
      configPath: string;
      warnings: string[];
    }
  | { type: "CLOSE_SETTINGS" }
  | { type: "SET_SETTINGS_CURSOR"; index: number }
  | { type: "SET_SETTINGS_INTERPRET"; interpret: InterpretConfigInput }
  | { type: "OPEN_MODULE_INSTANCE"; instance: ModuleInstance }
  | { type: "CLOSE_MODULE_INSTANCE"; instanceId: string }
  | { type: "UPDATE_MODULE_INSTANCE_STATE"; instanceId: string; state: unknown }
  | { type: "SELECT_MODULE"; index: number; visibleCount?: number };

export const initialState: AppState = {
  conversations: [],
  messages: [],
  selectedIdx: 0,
  selectedMsgIdx: -1,
  focus: "sidebar",
  mode: "browse",
  sidebarScroll: 0,
  threadScroll: 0,
  composeText: "",
  filterQuery: "",
  filterCursor: 0,
  filterReturnIdx: null,
  filterReturnScroll: 0,
  pending: [],
  loading: true,
  // Shown on the very first frame, before any DB work runs (App defers the
  // initial load by a macrotask so this actually reaches the screen).
  status: "Loading conversations…",
  numBuffer: "",
  showDevStats: false,
  drawerAttachmentIdx: 0,
  infoStats: null,
  infoEvents: [],
  infoAttachments: [],
  infoAttachmentIdx: 0,
  conversationLoadedCount: 0,
  conversationLoadingMore: false,
  messageOldestLoadedId: null,
  messageLoadingOlder: false,
  gapMarkers: [],
  selectionAnchor: null,
  exportFormat: "markdown",
  exportPath: "",
  exportStatus: "",
  dateJumpInput: "",
  dateJumpError: "",
  moduleInstances: [],
  selectedModuleIdx: null,
  paletteQuery: "",
  paletteCursor: 0,
  settingsInterpret: null,
  settingsKeyPresence: {},
  settingsCursor: 0,
  settingsConfigPath: "",
  settingsWarnings: [],
};

/** Clamp message cursor and ensure it's visible by adjusting scroll */
function clampMsg(state: AppState, idx: number): Partial<AppState> {
  const total = state.messages.length;
  if (total === 0) return { selectedMsgIdx: -1 };
  const clamped = Math.max(0, Math.min(idx, total - 1));
  return { selectedMsgIdx: clamped };
}

// ── Bounded message window ───────────────────────────────────────────────
// When loaded messages exceed HARD_CAP, evict the middle of the array but
// preserve two regions:
//   1. ANCHOR_KEEP at the END (most recent messages — user can press G)
//   2. WINDOW_BUFFER ± selectedMsgIdx (current viewing window)
// The evicted block becomes a gap marker so the renderer can show "N more
// messages — scroll to load" and the user can refill on demand.

const MESSAGES_HARD_CAP = Number.parseInt(process.env.IMSG_TUI_MSG_HARD_CAP ?? "5000", 10);
const ANCHOR_KEEP = 200;
const WINDOW_BUFFER = 300;

/**
 * Apply the bounding policy to a fresh `messages` array. Returns the trimmed
 * array, an updated `selectedMsgIdx`, and any new gap markers. Pure function.
 */
export function boundMessagesIfNeeded(
  messages: Message[],
  selectedMsgIdx: number,
  existingGaps: AppState["gapMarkers"],
): {
  messages: Message[];
  selectedMsgIdx: number;
  gapMarkers: AppState["gapMarkers"];
} {
  if (messages.length <= MESSAGES_HARD_CAP) {
    return { messages, selectedMsgIdx, gapMarkers: existingGaps };
  }

  const total = messages.length;
  // Keep the LAST ANCHOR_KEEP messages (most recent — anchor for G)
  const anchorStart = Math.max(total - ANCHOR_KEEP, 0);
  // Keep WINDOW_BUFFER on each side of the cursor
  const cursorLo = Math.max(0, selectedMsgIdx - WINDOW_BUFFER);
  const cursorHi = Math.min(total - 1, selectedMsgIdx + WINDOW_BUFFER);

  // Build the kept-set as a sorted list of [start, end] ranges, merged
  type Range = [number, number];
  const ranges: Range[] = [
    [cursorLo, cursorHi],
    [anchorStart, total - 1],
  ];
  // Sort by start; merge overlapping/adjacent
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of ranges) {
    if (merged.length === 0) {
      merged.push(r);
      continue;
    }
    const last = merged[merged.length - 1];
    if (r[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push(r);
    }
  }

  // Slice + concat the kept ranges, recording gaps between them
  const kept: Message[] = [];
  const gapMarkers: AppState["gapMarkers"] = [];
  for (let i = 0; i < merged.length; i++) {
    const [start, end] = merged[i];
    if (i > 0) {
      const prevEnd = merged[i - 1][1];
      const gapStart = prevEnd + 1;
      const gapEnd = start - 1;
      if (gapEnd >= gapStart) {
        gapMarkers.push({
          atIdx: kept.length,
          oldestId: messages[gapStart].id,
          newestId: messages[gapEnd].id,
          count: gapEnd - gapStart + 1,
        });
      }
    }
    for (let j = start; j <= end; j++) kept.push(messages[j]);
  }

  // Map old selectedMsgIdx to new index in `kept`
  let newCursor = -1;
  if (selectedMsgIdx >= 0) {
    let collapsedIdx = 0;
    for (const [start, end] of merged) {
      if (selectedMsgIdx >= start && selectedMsgIdx <= end) {
        newCursor = collapsedIdx + (selectedMsgIdx - start);
        break;
      }
      collapsedIdx += end - start + 1;
    }
    if (newCursor === -1) newCursor = 0; // cursor was in evicted region; clamp to start
  }

  // Note: existingGaps from before this trim aren't re-merged; we replace.
  // In practice gaps are always recomputed from the current array shape.
  return { messages: kept, selectedMsgIdx: newCursor, gapMarkers };
}

/**
 * Compute a `sidebarScroll` value that keeps `selectedIdx` inside the
 * visible window. Adds a 2-row buffer at each edge so the user sees what's
 * coming next when navigating with j/k. Pure function — used by reducer.
 *
 * @param selectedIdx the cursor's target index
 * @param currentScroll the current sidebar scroll offset
 * @param visibleCount how many items fit on-screen at once
 * @param totalCount total items available (for clamping)
 */
export function ensureVisibleScroll(
  selectedIdx: number,
  currentScroll: number,
  visibleCount: number,
  totalCount: number,
): number {
  if (visibleCount <= 0 || totalCount <= 0) return 0;
  const buffer = Math.min(2, Math.floor(visibleCount / 4));
  // If cursor is above the visible window (with buffer), scroll up
  if (selectedIdx < currentScroll + buffer) {
    return Math.max(0, selectedIdx - buffer);
  }
  // If cursor is below the visible window (with buffer), scroll down
  const lastVisible = currentScroll + visibleCount - 1;
  if (selectedIdx > lastVisible - buffer) {
    return Math.min(
      Math.max(0, totalCount - visibleCount),
      selectedIdx - visibleCount + 1 + buffer,
    );
  }
  // Already visible — don't move
  return Math.max(0, Math.min(currentScroll, Math.max(0, totalCount - visibleCount)));
}

/**
 * Total number of selectable rows in the sidebar — module instances stacked
 * on top of conversations. Used by the unified cursor model.
 */
export function sidebarRowCount(state: AppState): number {
  return state.moduleInstances.length + state.conversations.length;
}

/**
 * Combined sidebar cursor index ([0..moduleInstances.length-1] = modules,
 * [moduleInstances.length..] = conversations). Used to drive global j/k
 * navigation in the sidebar.
 */
export function combinedSidebarIndex(state: AppState): number {
  if (state.selectedModuleIdx != null) return state.selectedModuleIdx;
  return state.moduleInstances.length + state.selectedIdx;
}

/**
 * Apply live tapback events to their target messages (matched by guid),
 * mirroring the DB layer's consolidation semantics: one reaction per
 * sender+type+part, removals delete, re-adds replace. Returns the ORIGINAL
 * array when nothing matched so the reducer can bail without a re-render.
 * Pure function — exported for tests.
 */
export function applyLiveReactions(messages: Message[], reactions: Reaction[]): Message[] {
  const byTarget = new Map<string, Reaction[]>();
  for (const r of reactions) {
    if (!r.targetMessageGuid) continue;
    const list = byTarget.get(r.targetMessageGuid);
    if (list) list.push(r);
    else byTarget.set(r.targetMessageGuid, [r]);
  }
  if (byTarget.size === 0) return messages;

  let changed = false;
  const next = messages.map((m) => {
    const incoming = byTarget.get(m.guid);
    if (!incoming) return m;
    const keyOf = (r: Reaction) => `${r.fromHandle}-${r.type}-${r.targetMessagePart}`;
    const consolidated = new Map<string, Reaction>();
    for (const r of m.reactions ?? []) consolidated.set(keyOf(r), r);
    for (const r of incoming) {
      if (r.isRemoval) consolidated.delete(keyOf(r));
      else consolidated.set(keyOf(r), r);
    }
    changed = true;
    const list = [...consolidated.values()];
    return { ...m, reactions: list.length > 0 ? list : undefined };
  });
  return changed ? next : messages;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_CONVERSATIONS":
      return {
        ...state,
        conversations: action.data,
        conversationLoadedCount: action.data.length,
        conversationLoadingMore: false,
      };
    case "APPEND_CONVERSATIONS": {
      // Merge new entries by threadSlug (DB returns the same recent ones too)
      const existing = new Set(state.conversations.map((c) => c.threadSlug));
      const fresh = action.data.filter((c) => !existing.has(c.threadSlug));
      return {
        ...state,
        conversations: [...state.conversations, ...fresh],
        conversationLoadedCount: action.loadedCount,
        conversationLoadingMore: false,
      };
    }
    case "SET_MESSAGES": {
      // Scroll to bottom: set cursor to last message
      const msgs = action.data;
      const lastIdx = Math.max(0, msgs.length - 1);
      // Set threadScroll high so the view shows the bottom
      const scrollToEnd = Math.max(0, msgs.length);
      const oldestId = oldestMessageCursor(msgs);
      return {
        ...state,
        messages: msgs,
        pending: [],
        selectedMsgIdx: lastIdx,
        threadScroll: scrollToEnd,
        messageOldestLoadedId: oldestId,
        messageLoadingOlder: false,
        gapMarkers: [],
      };
    }
    case "SET_MESSAGE_INTERPRET": {
      // Attach a resolved transcript/caption to one message and return a NEW
      // messages array so the thread re-renders (bubbles read interpretedMedia).
      let changed = false;
      const messages = state.messages.map((m) => {
        if (m.id !== action.msgId) return m;
        changed = true;
        return { ...m, interpretedMedia: action.interpretedMedia };
      });
      return changed ? { ...state, messages } : state;
    }
    case "PREPEND_MESSAGES": {
      // Merge older messages at the start; dedup by id; preserve cursor on the
      // same logical message by shifting selectedMsgIdx by the count added.
      const existingIds = new Set(state.messages.map((m) => m.id));
      const fresh = action.data.filter((m) => !existingIds.has(m.id));
      const merged = [...fresh, ...state.messages].sort(
        (a, b) => a.date.getTime() - b.date.getTime(),
      );
      const shift = fresh.length;
      const shiftedCursor =
        state.selectedMsgIdx >= 0 ? state.selectedMsgIdx + shift : state.selectedMsgIdx;

      // Apply bounded-window eviction if we've grown past the cap
      const bounded = boundMessagesIfNeeded(merged, shiftedCursor, state.gapMarkers);

      // The "load older" cursor must describe what SURVIVED, not what was
      // fetched. When bounding evicts the head of the batch we just prepended,
      // `action.oldestId` (the fetch's oldest) claims we've already loaded
      // further back than the array actually holds — the next load-older then
      // pages from BELOW the evicted rows, skipping them forever and reporting
      // false exhaustion with a silent hole where they were. Recompute from the
      // survivors whenever eviction dropped rows; otherwise keep the caller's
      // cursor untouched, because `-1` is the exhaustion sentinel and an empty
      // prepend must not resurrect paging.
      const evicted = bounded.messages.length < merged.length;
      const oldestLoadedId = evicted
        ? (oldestMessageCursor(bounded.messages) ?? action.oldestId)
        : action.oldestId;

      return {
        ...state,
        messages: bounded.messages,
        selectedMsgIdx: bounded.selectedMsgIdx,
        gapMarkers: bounded.gapMarkers,
        messageOldestLoadedId: oldestLoadedId,
        messageLoadingOlder: false,
      };
    }
    case "APPEND_LIVE_MESSAGES": {
      // Live stream append (ChangeWatcher → EventBus). Dedupe by ROWID AND
      // guid: the post-send confirm poll and lazy loads race the stream, and
      // either side can land the same row first.
      const existingIds = new Set(state.messages.map((m) => m.id));
      const existingGuids = new Set(state.messages.map((m) => m.guid));
      const fresh = action.data.filter((m) => !existingIds.has(m.id) && !existingGuids.has(m.guid));
      if (fresh.length === 0) return state;
      // Follow the tail only when the cursor already sits on it — ThreadPane
      // windows around selectedMsgIdx, so a user scrolled up keeps their
      // anchor and the view must not jump when messages arrive.
      const atTail =
        state.messages.length === 0 || state.selectedMsgIdx >= state.messages.length - 1;
      const merged = [...state.messages, ...fresh];
      const cursor = atTail ? merged.length - 1 : state.selectedMsgIdx;
      // Same bounded-memory policy as every other growth path.
      const bounded = boundMessagesIfNeeded(merged, cursor, state.gapMarkers);
      // A from-me row arriving on the stream resolves its optimistic pending
      // bubble (same containment match as the send confirm-poll) so the two
      // never render together.
      const pending = state.pending.filter(
        (p) => !fresh.some((m) => m.isFromMe && m.text?.includes(p.text)),
      );
      return {
        ...state,
        messages: bounded.messages,
        selectedMsgIdx: bounded.selectedMsgIdx,
        gapMarkers: bounded.gapMarkers,
        threadScroll: atTail ? bounded.messages.length : state.threadScroll,
        pending,
        // A thread that was empty before the stream fed it needs an oldest-id
        // cursor for the lazy "load older" path; -1 (exhausted) stays put.
        messageOldestLoadedId: state.messageOldestLoadedId ?? oldestMessageCursor(bounded.messages),
      };
    }
    case "APPLY_LIVE_REACTIONS": {
      const next = applyLiveReactions(state.messages, action.reactions);
      return next === state.messages ? state : { ...state, messages: next };
    }
    case "TOUCH_CONVERSATIONS": {
      // Sidebar freshness from the live stream: patch snippet / date / unread
      // IN PLACE — no reorder. Resorting under the user's cursor would yank
      // rows mid-navigation; the manual `r` refresh still re-sorts.
      if (action.touches.length === 0) return state;
      const bySlug = new Map(action.touches.map((t) => [t.threadSlug, t]));
      let changed = false;
      const conversations = state.conversations.map((c) => {
        const t = bySlug.get(c.threadSlug);
        if (!t) return c;
        changed = true;
        return {
          ...c,
          lastMessageSnippet: t.snippet ?? c.lastMessageSnippet,
          lastMessageDate: t.lastMessageDate,
          unreadCount: Math.max(0, c.unreadCount + t.unreadDelta),
        };
      });
      return changed ? { ...state, conversations } : state;
    }
    case "SET_LOADING_OLDER":
      return { ...state, messageLoadingOlder: action.loading };
    case "ENTER_SELECT_MODE":
      return { ...state, mode: "select", selectionAnchor: state.selectedMsgIdx };
    case "EXIT_SELECT_MODE":
      return { ...state, mode: "browse", selectionAnchor: null };
    case "ENTER_EXPORT_MODE":
      return { ...state, mode: "export", exportPath: action.defaultPath };
    case "EXIT_EXPORT_MODE":
      return { ...state, mode: state.selectionAnchor != null ? "select" : "browse" };
    case "SET_EXPORT_FORMAT":
      return { ...state, exportFormat: action.format };
    case "SET_EXPORT_PATH":
      return { ...state, exportPath: action.path };
    case "SET_EXPORT_STATUS":
      return { ...state, exportStatus: action.status };
    case "ENTER_DATE_JUMP":
      return { ...state, mode: "date-jump", dateJumpInput: "", dateJumpError: "" };
    case "EXIT_DATE_JUMP":
      return { ...state, mode: "browse", dateJumpInput: "", dateJumpError: "" };
    case "ENTER_SEND_VIA":
      return { ...state, mode: "send-via" };
    case "EXIT_SEND_VIA":
      return { ...state, mode: "browse" };
    case "ENTER_COMPOSE_NEW":
      return { ...state, mode: "compose-new", focus: "sidebar" };
    case "EXIT_COMPOSE_NEW":
      return { ...state, mode: "browse" };
    case "SET_DATE_JUMP_INPUT":
      return { ...state, dateJumpInput: action.value, dateJumpError: "" };
    case "SET_DATE_JUMP_ERROR":
      return { ...state, dateJumpError: action.error };
    case "SELECT": {
      const idx = Math.max(0, Math.min(action.index, Math.max(0, state.conversations.length - 1)));
      const sidebarScroll = action.visibleCount
        ? ensureVisibleScroll(
            // The visible row index is offset by the module rows above.
            idx + state.moduleInstances.length,
            state.sidebarScroll,
            action.visibleCount,
            sidebarRowCount(state),
          )
        : state.sidebarScroll;
      // Selecting a real conversation always clears module focus.
      return { ...state, selectedIdx: idx, sidebarScroll, selectedModuleIdx: null };
    }
    case "SELECT_MSG_BY_DATE": {
      // Find the first message at or after the target date in the LIVE list.
      // Used by date-jump so selection runs against the reducer's current
      // messages, not a stale closure snapshot.
      const t = action.date.getTime();
      let idx = state.messages.findIndex((m) => m.date.getTime() >= t);
      if (idx < 0) idx = state.messages.length - 1; // all older than target → last
      if (idx < 0) return state;
      return { ...state, ...clampMsg(state, idx) };
    }
    case "SELECT_MSG": {
      const c = clampMsg(state, action.index);
      return { ...state, ...c };
    }
    case "MOVE_MSG": {
      const c = clampMsg(state, state.selectedMsgIdx + action.delta);
      return { ...state, ...c };
    }
    case "FOCUS":
      return { ...state, focus: action.pane, numBuffer: "" };
    case "SCROLL_SIDEBAR":
      return { ...state, sidebarScroll: Math.max(0, state.sidebarScroll + action.delta) };
    case "SCROLL_THREAD":
      return { ...state, threadScroll: Math.max(0, state.threadScroll + action.delta) };
    case "SCROLL_THREAD_TO":
      return { ...state, threadScroll: Math.max(0, action.position) };
    case "ENTER_COMPOSE":
      return { ...state, mode: "compose", composeText: "", focus: "thread" };
    case "UPDATE_COMPOSE":
      return { ...state, composeText: action.text };
    case "CONFIRM_SEND":
      return { ...state, mode: "confirm" };
    case "CANCEL_COMPOSE":
      return { ...state, mode: "browse", composeText: "" };
    case "ADD_PENDING":
      return { ...state, mode: "browse", composeText: "", pending: [...state.pending, action.msg] };
    case "RESOLVE_PENDING":
      return { ...state, pending: state.pending.filter((p) => p.text !== action.text) };
    case "FAIL_PENDING":
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.text === action.text ? { ...p, status: "failed" as const } : p,
        ),
      };
    case "SET_LOADING":
      return { ...state, loading: action.loading, status: action.status ?? state.status };
    case "SET_STATUS":
      return { ...state, status: action.status };
    case "ENTER_FILTER":
      // Reset cursor + scroll to the top: the filtered list shrinks, and a
      // stale scroll offset (e.g. after `G`) would slice past every match and
      // render "No conversations" despite the header showing a non-zero count.
      //
      // Remember where we came from so Escape can put it back — filtering moves
      // selectedIdx as a side effect (see UPDATE_FILTER), and without this the
      // cancel path silently reassigns the user's selection.
      return {
        ...state,
        mode: "filter",
        filterQuery: "",
        focus: "sidebar",
        selectedIdx: 0,
        selectedModuleIdx: null,
        sidebarScroll: 0,
        filterCursor: 0,
        filterReturnIdx: state.selectedIdx,
        filterReturnScroll: state.sidebarScroll,
      };
    case "UPDATE_FILTER":
      // Each keystroke re-filters; snap the filtered cursor + scroll back to the
      // top so the highlight lands on the first match of the new query.
      return {
        ...state,
        filterQuery: action.query,
        selectedIdx: 0,
        selectedModuleIdx: null,
        sidebarScroll: 0,
        filterCursor: 0,
      };
    case "FILTER_MOVE": {
      // Walk the FILTERED result set (arrows / Ctrl-n/p in filter mode). The
      // cursor is a position into the matches, not the full array — clamp it to
      // the match count and scroll the combined [modules, ...filtered] list so
      // the highlighted match stays on screen.
      const matchCount = filterMatchIndices(state.conversations, state.filterQuery).length;
      if (matchCount === 0) return state;
      const cursor = Math.max(0, Math.min(state.filterCursor + action.delta, matchCount - 1));
      const sidebarScroll = action.visibleCount
        ? ensureVisibleScroll(
            state.moduleInstances.length + cursor,
            state.sidebarScroll,
            action.visibleCount,
            state.moduleInstances.length + matchCount,
          )
        : state.sidebarScroll;
      return { ...state, filterCursor: cursor, sidebarScroll };
    }
    case "EXIT_FILTER": {
      const base = { ...state, mode: "browse" as const, filterQuery: "", filterCursor: 0 };
      // Commit (Enter) already dispatched SELECT for the highlighted match —
      // restoring here would immediately undo it.
      if (!action.restoreSelection) return { ...base, filterReturnIdx: null };
      // Cancel (Escape): put the selection back where it was before `/`.
      // UPDATE_FILTER snaps selectedIdx to 0 on every keystroke, so without
      // this the pane renders the PREVIOUS thread's messages and count under
      // conversation #0's name until j/k happens to reload it.
      if (state.filterReturnIdx == null) return { ...base, filterReturnIdx: null };
      return {
        ...base,
        selectedIdx: Math.min(state.filterReturnIdx, Math.max(0, state.conversations.length - 1)),
        sidebarScroll: state.filterReturnScroll,
        filterReturnIdx: null,
      };
    }
    case "OPEN_DRAWER":
      return { ...state, mode: "drawer", drawerAttachmentIdx: 0 };
    case "CLOSE_DRAWER":
      return { ...state, mode: "browse" };
    case "SET_DRAWER_ATTACHMENT":
      return { ...state, drawerAttachmentIdx: Math.max(0, action.index) };
    case "OPEN_INFO_DRAWER":
      return {
        ...state,
        mode: "info",
        infoStats: action.stats,
        infoEvents: action.events,
        infoAttachments: action.attachments,
        infoAttachmentIdx: 0,
      };
    case "CLOSE_INFO_DRAWER":
      return { ...state, mode: "browse" };
    case "SET_INFO_ATTACHMENT":
      return {
        ...state,
        infoAttachmentIdx: Math.max(
          0,
          Math.min(action.index, Math.max(0, state.infoAttachments.length - 1)),
        ),
      };
    case "SET_NUM_BUFFER":
      return { ...state, numBuffer: action.value };
    case "TOGGLE_DEV_STATS":
      return { ...state, showDevStats: !state.showDevStats };

    // ── Command palette ────────────────────────────────────────────────
    case "OPEN_PALETTE":
      return { ...state, mode: "palette", paletteQuery: "", paletteCursor: 0 };
    case "CLOSE_PALETTE":
      return { ...state, mode: "browse" };
    case "SET_PALETTE_QUERY":
      // Reset cursor to the top so the highlighted row is always the best
      // match for the freshest query.
      return { ...state, paletteQuery: action.query, paletteCursor: 0 };
    case "MOVE_PALETTE_CURSOR":
      return { ...state, paletteCursor: Math.max(0, state.paletteCursor + action.delta) };
    case "SET_PALETTE_CURSOR":
      return { ...state, paletteCursor: Math.max(0, action.index) };

    // ── Settings panel ─────────────────────────────────────────────────
    case "OPEN_SETTINGS":
      return {
        ...state,
        mode: "settings",
        settingsInterpret: action.interpret,
        settingsKeyPresence: action.keyPresence,
        settingsConfigPath: action.configPath,
        settingsWarnings: action.warnings,
        settingsCursor: 0,
      };
    case "CLOSE_SETTINGS":
      return { ...state, mode: "browse" };
    case "SET_SETTINGS_CURSOR":
      return { ...state, settingsCursor: Math.max(0, action.index) };
    case "SET_SETTINGS_INTERPRET":
      return { ...state, settingsInterpret: action.interpret };

    // ── Module instances ───────────────────────────────────────────────
    case "OPEN_MODULE_INSTANCE": {
      // Prepend so newest is at the top of the sidebar, then focus it.
      const moduleInstances = [action.instance, ...state.moduleInstances];
      return {
        ...state,
        mode: "browse",
        moduleInstances,
        selectedModuleIdx: 0,
        focus: "sidebar",
      };
    }
    case "CLOSE_MODULE_INSTANCE": {
      const idx = state.moduleInstances.findIndex((i) => i.id === action.instanceId);
      if (idx === -1) return state;
      const moduleInstances = state.moduleInstances.filter((_, i) => i !== idx);
      // If the removed instance was selected, fall focus back to the first
      // real conversation (or the first remaining module, if any).
      let selectedModuleIdx: number | null = state.selectedModuleIdx;
      let selectedIdx = state.selectedIdx;
      if (state.selectedModuleIdx === idx) {
        if (moduleInstances.length > 0) {
          selectedModuleIdx = Math.min(idx, moduleInstances.length - 1);
        } else {
          selectedModuleIdx = null;
          selectedIdx = 0;
        }
      } else if (state.selectedModuleIdx != null && state.selectedModuleIdx > idx) {
        selectedModuleIdx = state.selectedModuleIdx - 1;
      }
      return { ...state, moduleInstances, selectedModuleIdx, selectedIdx };
    }
    case "UPDATE_MODULE_INSTANCE_STATE":
      return {
        ...state,
        moduleInstances: state.moduleInstances.map((i) =>
          i.id === action.instanceId ? { ...i, state: action.state } : i,
        ),
      };
    case "SELECT_MODULE": {
      const idx = Math.max(
        0,
        Math.min(action.index, Math.max(0, state.moduleInstances.length - 1)),
      );
      const sidebarScroll = action.visibleCount
        ? ensureVisibleScroll(idx, state.sidebarScroll, action.visibleCount, sidebarRowCount(state))
        : state.sidebarScroll;
      return { ...state, selectedModuleIdx: idx, sidebarScroll };
    }
    default:
      return state;
  }
}
