// AppState + Action union for the TUI. Pure — no React, no Ink, no Gmail
// imports. Anything that touches the network (fetches inbox, opens a thread)
// lives in hooks; the reducer just receives the result via dispatch.

import type { z } from "zod";
import type {
  GetThreadOutputSchema,
  ListAccountsOutputSchema,
  ListEmailLabelsOutputSchema,
  ListInboxThreadsOutputSchema,
} from "../tools.js";

export type Mode = "normal" | "insert" | "command";
// Drill-down focus order (left → right): each step right (`l` / `pane.open`)
// drills into the selected item; each step left (`h` / `pane.close`) returns
// to the previous level. `message` is the compact list of messages within
// the open thread (yazi-style); `view` is the full-body single message.
export type Pane = "sidebar" | "threads" | "message" | "view";

export type LabelList = z.infer<typeof ListEmailLabelsOutputSchema>;
type BaseThreadList = z.infer<typeof ListInboxThreadsOutputSchema>;
type BaseThreadView = z.infer<typeof GetThreadOutputSchema>;
export type ThreadList = Omit<BaseThreadList, "threads"> & {
  threads: Array<
    BaseThreadList["threads"][number] & { accountId?: string; emailAddress?: string | null }
  >;
};
export type ThreadView = Omit<BaseThreadView, "messages"> & {
  accountId?: string;
  emailAddress?: string | null;
  messages: Array<
    BaseThreadView["messages"][number] & { accountId?: string; emailAddress?: string | null }
  >;
};
export type AccountList = z.infer<typeof ListAccountsOutputSchema>;
export type BrowseScope =
  | { kind: "single"; accountId: string | null }
  | { kind: "all" }
  | { kind: "selected"; accountIds: string[] };

export type Overlay =
  | { kind: "none" }
  | { kind: "command"; text: string }
  | { kind: "search"; text: string }
  | { kind: "confirm"; prompt: string; pendingCmd: string }
  | { kind: "theme"; cursor: number }
  | { kind: "account"; cursor: number; selectedIds?: string[] }
  | { kind: "label"; mode: "add" | "remove"; text: string };

export interface AppState {
  mode: Mode;
  focus: Pane;
  // Sidebar (labels)
  labels: LabelList | null;
  labelCursor: number;
  selectedLabelId: string; // gmail label id, e.g. "INBOX"
  // Thread list pane
  threads: ThreadList | null;
  threadCursor: number;
  // Message reader pane
  thread: ThreadView | null;
  messageCursor: number;
  // Modal / overlay state
  showHelp: boolean;
  /** Fuzzysort filter typed into the help modal. Empty = unfiltered grid. */
  helpFilter: string;
  /** Cursor row within the filtered hit list (used only when filter is non-empty). */
  helpCursor: number;
  showStats: boolean;
  overlay: Overlay;
  // Active account chip + cached list for the switcher overlay
  account: AccountList["active"] | null;
  accountList: AccountList | null;
  scope: BrowseScope;
  // Theme (mutable via :theme command)
  themeName: string;
  // Transient status bar text + last action
  status: string;
  loading: boolean;
  error: string | null;
  // Quit signal — App reads this and calls Ink's exit()
  quit: boolean;
  // Pending key sequence (for two-char bindings like `gg`)
  keyBuffer: string;
  // Editor suspension marker — App reads this and triggers useEditor
  pendingEditor: null | {
    kind: "compose" | "reply" | "reply-all" | "draft-edit";
    initialContent: string;
    /** For reply / reply-all: the source message id. */
    sourceMessageId?: string;
    /** For reply / reply-all: the source thread id (so send_email replies into the same thread). */
    sourceThreadId?: string;
  };
}

export const initialState: AppState = {
  mode: "normal",
  focus: "threads",
  labels: null,
  labelCursor: 0,
  selectedLabelId: "INBOX",
  threads: null,
  threadCursor: 0,
  thread: null,
  messageCursor: 0,
  showHelp: false,
  helpFilter: "",
  helpCursor: 0,
  showStats: false,
  overlay: { kind: "none" },
  account: null,
  accountList: null,
  scope: { kind: "single", accountId: null },
  themeName: "default",
  status: "Loading inbox…",
  loading: true,
  error: null,
  quit: false,
  keyBuffer: "",
  pendingEditor: null,
};

export type Action =
  | { type: "SET_LABELS"; payload: LabelList }
  | { type: "SET_THREADS"; payload: ThreadList }
  | { type: "SET_THREAD"; payload: ThreadView }
  | { type: "SET_ACCOUNT"; payload: AccountList["active"] | null }
  | { type: "SET_ACCOUNT_LIST"; payload: AccountList | null }
  | { type: "SET_SCOPE"; payload: BrowseScope }
  | { type: "TOGGLE_STATS" }
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "SET_STATUS"; payload: string }
  | { type: "SET_ERROR"; payload: string | null }
  | { type: "SET_MODE"; payload: Mode }
  | { type: "SET_FOCUS"; payload: Pane }
  | { type: "SET_THEME"; payload: string }
  | { type: "CURSOR_DOWN" }
  | { type: "CURSOR_UP" }
  | { type: "CURSOR_TOP" }
  | { type: "CURSOR_BOTTOM" }
  /** Generic cursor delta — used by half-page / page / [ / ] motions where
      the magnitude is computed in App.tsx from the live terminal height. */
  | { type: "CURSOR_MOVE"; payload: number }
  /** Snap cursor to the middle of the current list — vim H/M/L's `M`. */
  | { type: "CURSOR_MIDDLE" }
  | { type: "SELECT_LABEL"; payload: string }
  | { type: "OPEN_THREAD" }
  | { type: "CLOSE_PANE" }
  | { type: "TOGGLE_HELP" }
  | { type: "QUIT" }
  | { type: "APPEND_KEY"; payload: string }
  | { type: "CLEAR_KEY_BUFFER" }
  | { type: "OPEN_OVERLAY"; payload: Overlay }
  | { type: "CLOSE_OVERLAY" }
  | { type: "OVERLAY_INPUT"; payload: string }
  | { type: "OVERLAY_BACKSPACE" }
  | { type: "REQUEST_EDITOR"; payload: NonNullable<AppState["pendingEditor"]> }
  | { type: "CLEAR_EDITOR" }
  /** Help modal — fuzzy filter input + filtered-list cursor. */
  | { type: "HELP_FILTER_INPUT"; payload: string }
  | { type: "HELP_FILTER_BACKSPACE" }
  | { type: "HELP_CURSOR_MOVE"; payload: number }
  | { type: "HELP_RESET" };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_LABELS":
      return { ...state, labels: action.payload };
    case "SET_THREADS":
      return {
        ...state,
        threads: action.payload,
        threadCursor: 0,
        loading: false,
      };
    case "SET_THREAD":
      return {
        ...state,
        thread: action.payload,
        messageCursor: 0,
        focus: "message",
      };
    case "SET_ACCOUNT":
      return { ...state, account: action.payload };
    case "SET_ACCOUNT_LIST":
      return { ...state, accountList: action.payload };
    case "SET_SCOPE":
      return {
        ...state,
        scope: action.payload,
        labels: null,
        labelCursor: 0,
        selectedLabelId: "INBOX",
        threads: null,
        threadCursor: 0,
        thread: null,
        messageCursor: 0,
        focus: "threads",
        status: "Loading inbox…",
        loading: true,
        error: null,
      };
    case "TOGGLE_STATS":
      return { ...state, showStats: !state.showStats };
    case "SET_LOADING":
      return { ...state, loading: action.payload };
    case "SET_STATUS":
      return { ...state, status: action.payload };
    case "SET_ERROR":
      return { ...state, error: action.payload, loading: false };
    case "SET_MODE":
      return { ...state, mode: action.payload };
    case "SET_FOCUS":
      return { ...state, focus: action.payload };
    case "CURSOR_TOP":
      return setCursorAbs(state, 0);
    case "CURSOR_BOTTOM":
      return setCursorAbs(state, "end");
    case "SELECT_LABEL":
      // Clear the previous label's thread list AND any open thread — without
      // this, the auto-open-first-thread useEffect can race the label load
      // and re-fetch (then SET_THREAD) the previous label's first thread,
      // which flips focus back to message and shows stale content under a
      // new label name.
      return {
        ...state,
        selectedLabelId: action.payload,
        threadCursor: 0,
        threads: null,
        thread: null,
        messageCursor: 0,
        loading: true,
        status: "Loading…",
      };
    case "OPEN_THREAD":
      // Triggers an async fetch in App; reducer only flips focus + loading.
      return { ...state, loading: true, status: "Opening thread…" };
    case "CLOSE_PANE":
      // Drill-down inverse: view → message → threads → sidebar. Last step
      // discards the loaded thread so re-opening fetches fresh state.
      if (state.focus === "view") {
        return { ...state, focus: "message" };
      }
      if (state.focus === "message") {
        return { ...state, focus: "threads", thread: null };
      }
      if (state.focus === "threads") {
        return { ...state, focus: "sidebar" };
      }
      return state;
    case "TOGGLE_HELP":
      // Closing help resets the filter + cursor so the next open is fresh.
      return state.showHelp
        ? { ...state, showHelp: false, helpFilter: "", helpCursor: 0 }
        : { ...state, showHelp: true };
    case "HELP_FILTER_INPUT":
      return { ...state, helpFilter: state.helpFilter + action.payload, helpCursor: 0 };
    case "HELP_FILTER_BACKSPACE":
      return {
        ...state,
        helpFilter: state.helpFilter.slice(0, -1),
        helpCursor: 0,
      };
    case "HELP_CURSOR_MOVE":
      // App.tsx clamps the cursor against the current filtered hit count
      // before dispatching this — the reducer just records the new value.
      return { ...state, helpCursor: Math.max(0, state.helpCursor + action.payload) };
    case "HELP_RESET":
      return { ...state, helpFilter: "", helpCursor: 0 };
    case "QUIT":
      return { ...state, quit: true };
    case "APPEND_KEY":
      return { ...state, keyBuffer: state.keyBuffer + action.payload };
    case "CLEAR_KEY_BUFFER":
      return { ...state, keyBuffer: "" };
    case "SET_THEME":
      return { ...state, themeName: action.payload };
    case "OPEN_OVERLAY":
      // Text-input overlays flip to insert mode so chars go into the buffer
      // instead of triggering normal-mode bindings. Confirm / theme / account
      // stay in normal — they have their own modal-aware input branches.
      return {
        ...state,
        overlay: action.payload,
        mode:
          action.payload.kind === "command" ||
          action.payload.kind === "search" ||
          action.payload.kind === "label"
            ? "insert"
            : state.mode,
      };
    case "CLOSE_OVERLAY":
      return { ...state, overlay: { kind: "none" }, mode: "normal" };
    case "OVERLAY_INPUT":
      if (
        state.overlay.kind === "command" ||
        state.overlay.kind === "search" ||
        state.overlay.kind === "label"
      ) {
        return {
          ...state,
          overlay: { ...state.overlay, text: state.overlay.text + action.payload },
        };
      }
      return state;
    case "OVERLAY_BACKSPACE":
      if (
        (state.overlay.kind === "command" ||
          state.overlay.kind === "search" ||
          state.overlay.kind === "label") &&
        state.overlay.text.length > 0
      ) {
        return {
          ...state,
          overlay: { ...state.overlay, text: state.overlay.text.slice(0, -1) },
        };
      }
      return state;
    case "CURSOR_DOWN":
      if (state.overlay.kind === "theme") return overlayThemeCursor(state, +1);
      if (state.overlay.kind === "account") return overlayAccountCursor(state, +1);
      return moveCursor(state, +1);
    case "CURSOR_UP":
      if (state.overlay.kind === "theme") return overlayThemeCursor(state, -1);
      if (state.overlay.kind === "account") return overlayAccountCursor(state, -1);
      return moveCursor(state, -1);
    case "CURSOR_MOVE":
      return moveCursor(state, action.payload);
    case "CURSOR_MIDDLE":
      return setCursorAbs(state, "middle");
    case "REQUEST_EDITOR":
      return { ...state, pendingEditor: action.payload };
    case "CLEAR_EDITOR":
      return { ...state, pendingEditor: null };
    default:
      return state;
  }
}

function moveCursor(state: AppState, delta: number): AppState {
  if (state.focus === "sidebar") {
    const items = (state.labels?.system.length ?? 0) + (state.labels?.user.length ?? 0);
    const next = clamp(state.labelCursor + delta, 0, Math.max(0, items - 1));
    return { ...state, labelCursor: next };
  }
  if (state.focus === "threads") {
    const items = state.threads?.threads.length ?? 0;
    const next = clamp(state.threadCursor + delta, 0, Math.max(0, items - 1));
    return { ...state, threadCursor: next };
  }
  if (state.focus === "message" || state.focus === "view") {
    // `view` shares the message cursor — j/k in the single-message view
    // pages between messages in the open thread, keeping the right pane in
    // sync with the compact list to the left.
    const items = state.thread?.messages.length ?? 0;
    const next = clamp(state.messageCursor + delta, 0, Math.max(0, items - 1));
    return { ...state, messageCursor: next };
  }
  return state;
}

function setCursorAbs(state: AppState, pos: number | "end" | "middle"): AppState {
  const resolve = (items: number) =>
    pos === "end"
      ? Math.max(0, items - 1)
      : pos === "middle"
        ? Math.floor(Math.max(0, items - 1) / 2)
        : clamp(pos, 0, Math.max(0, items - 1));
  if (state.focus === "sidebar") {
    const items = (state.labels?.system.length ?? 0) + (state.labels?.user.length ?? 0);
    return { ...state, labelCursor: resolve(items) };
  }
  if (state.focus === "threads") {
    const items = state.threads?.threads.length ?? 0;
    return { ...state, threadCursor: resolve(items) };
  }
  if (state.focus === "message" || state.focus === "view") {
    const items = state.thread?.messages.length ?? 0;
    return { ...state, messageCursor: resolve(items) };
  }
  return state;
}

function clamp(n: number, min: number, max: number): number {
  if (max < min) return min;
  return n < min ? min : n > max ? max : n;
}

function overlayThemeCursor(state: AppState, delta: number): AppState {
  if (state.overlay.kind !== "theme") return state;
  // 8 themes shipped; the picker reads listThemeNames() at render time.
  // Bound here by the static count to keep the reducer pure.
  const count = 8;
  const next = clamp(state.overlay.cursor + delta, 0, count - 1);
  return { ...state, overlay: { ...state.overlay, cursor: next } };
}

function overlayAccountCursor(state: AppState, delta: number): AppState {
  if (state.overlay.kind !== "account") return state;
  const items = (state.accountList?.accounts.length ?? 0) + 1;
  const next = clamp(state.overlay.cursor + delta, 0, Math.max(0, items - 1));
  return { ...state, overlay: { ...state.overlay, cursor: next } };
}
