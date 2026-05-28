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
export type Pane = "sidebar" | "threads" | "message";

export type LabelList = z.infer<typeof ListEmailLabelsOutputSchema>;
export type ThreadList = z.infer<typeof ListInboxThreadsOutputSchema>;
export type ThreadView = z.infer<typeof GetThreadOutputSchema>;
export type AccountList = z.infer<typeof ListAccountsOutputSchema>;

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
  // Active account chip
  account: AccountList["active"] | null;
  // Transient status bar text + last action
  status: string;
  loading: boolean;
  error: string | null;
  // Quit signal — App reads this and calls Ink's exit()
  quit: boolean;
  // Pending key sequence (for two-char bindings like `gg`)
  keyBuffer: string;
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
  account: null,
  status: "Loading inbox…",
  loading: true,
  error: null,
  quit: false,
  keyBuffer: "",
};

export type Action =
  | { type: "SET_LABELS"; payload: LabelList }
  | { type: "SET_THREADS"; payload: ThreadList }
  | { type: "SET_THREAD"; payload: ThreadView }
  | { type: "SET_ACCOUNT"; payload: AccountList["active"] | null }
  | { type: "SET_LOADING"; payload: boolean }
  | { type: "SET_STATUS"; payload: string }
  | { type: "SET_ERROR"; payload: string | null }
  | { type: "SET_MODE"; payload: Mode }
  | { type: "SET_FOCUS"; payload: Pane }
  | { type: "CURSOR_DOWN" }
  | { type: "CURSOR_UP" }
  | { type: "CURSOR_TOP" }
  | { type: "CURSOR_BOTTOM" }
  | { type: "SELECT_LABEL"; payload: string }
  | { type: "OPEN_THREAD" }
  | { type: "CLOSE_PANE" }
  | { type: "TOGGLE_HELP" }
  | { type: "QUIT" }
  | { type: "APPEND_KEY"; payload: string }
  | { type: "CLEAR_KEY_BUFFER" };

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
    case "CURSOR_DOWN":
      return moveCursor(state, +1);
    case "CURSOR_UP":
      return moveCursor(state, -1);
    case "CURSOR_TOP":
      return setCursorAbs(state, 0);
    case "CURSOR_BOTTOM":
      return setCursorAbs(state, "end");
    case "SELECT_LABEL":
      return {
        ...state,
        selectedLabelId: action.payload,
        threadCursor: 0,
        loading: true,
        status: "Loading…",
      };
    case "OPEN_THREAD":
      // Triggers an async fetch in App; reducer only flips focus + loading.
      return { ...state, loading: true, status: "Opening thread…" };
    case "CLOSE_PANE":
      // From message → threads; from threads → sidebar. Final close in App.
      if (state.focus === "message") {
        return { ...state, focus: "threads", thread: null };
      }
      if (state.focus === "threads") {
        return { ...state, focus: "sidebar" };
      }
      return state;
    case "TOGGLE_HELP":
      return { ...state, showHelp: !state.showHelp };
    case "QUIT":
      return { ...state, quit: true };
    case "APPEND_KEY":
      return { ...state, keyBuffer: state.keyBuffer + action.payload };
    case "CLEAR_KEY_BUFFER":
      return { ...state, keyBuffer: "" };
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
  if (state.focus === "message") {
    const items = state.thread?.messages.length ?? 0;
    const next = clamp(state.messageCursor + delta, 0, Math.max(0, items - 1));
    return { ...state, messageCursor: next };
  }
  return state;
}

function setCursorAbs(state: AppState, pos: number | "end"): AppState {
  if (state.focus === "sidebar") {
    const items = (state.labels?.system.length ?? 0) + (state.labels?.user.length ?? 0);
    const next = pos === "end" ? Math.max(0, items - 1) : clamp(pos, 0, Math.max(0, items - 1));
    return { ...state, labelCursor: next };
  }
  if (state.focus === "threads") {
    const items = state.threads?.threads.length ?? 0;
    const next = pos === "end" ? Math.max(0, items - 1) : clamp(pos, 0, Math.max(0, items - 1));
    return { ...state, threadCursor: next };
  }
  if (state.focus === "message") {
    const items = state.thread?.messages.length ?? 0;
    const next = pos === "end" ? Math.max(0, items - 1) : clamp(pos, 0, Math.max(0, items - 1));
    return { ...state, messageCursor: next };
  }
  return state;
}

function clamp(n: number, min: number, max: number): number {
  if (max < min) return min;
  return n < min ? min : n > max ? max : n;
}
