// Pure reducer + keymap tests. No Ink, no Gmail — verify the state machine
// the TUI is built on without touching IO.

import { describe, expect, it } from "vitest";
import { resolveKey } from "./keymap.js";
import {
  type AppState,
  initialState,
  type LabelList,
  reducer,
  type ThreadList,
} from "./reducer.js";

const fakeLabels: LabelList = {
  count: { total: 3, system: 2, user: 1 },
  system: [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "SENT", name: "SENT", type: "system" },
  ],
  user: [{ id: "Label_1", name: "Releases", type: "user" }],
};

const fakeThreads: ThreadList = {
  resultCount: 2,
  threads: [
    {
      threadId: "t1",
      snippet: "s1",
      historyId: "h1",
      messageCount: 1,
      latestMessage: { from: "a@x.test", subject: "hello", date: "Mon, 1 Jan 2026 00:00:00 +0000" },
    },
    {
      threadId: "t2",
      snippet: "s2",
      historyId: "h2",
      messageCount: 1,
      latestMessage: { from: "b@x.test", subject: "world", date: "Mon, 1 Jan 2026 00:00:00 +0000" },
    },
  ],
};

describe("reducer", () => {
  it("loads labels and threads without mutating prior state", () => {
    const s1 = reducer(initialState, { type: "SET_LABELS", payload: fakeLabels });
    const s2 = reducer(s1, { type: "SET_THREADS", payload: fakeThreads });
    expect(s2.labels).toBe(fakeLabels);
    expect(s2.threads).toBe(fakeThreads);
    expect(s2.threadCursor).toBe(0);
    expect(s2.loading).toBe(false);
    // Original state should be untouched (no mutation).
    expect(initialState.labels).toBeNull();
    expect(initialState.threads).toBeNull();
  });

  it("clamps cursor to thread list bounds", () => {
    let s: AppState = reducer(initialState, { type: "SET_THREADS", payload: fakeThreads });
    s = reducer(s, { type: "CURSOR_DOWN" });
    expect(s.threadCursor).toBe(1);
    // Past end → stays at last
    s = reducer(s, { type: "CURSOR_DOWN" });
    expect(s.threadCursor).toBe(1);
    // CURSOR_UP works
    s = reducer(s, { type: "CURSOR_UP" });
    expect(s.threadCursor).toBe(0);
    // Past start → stays at 0
    s = reducer(s, { type: "CURSOR_UP" });
    expect(s.threadCursor).toBe(0);
  });

  it("CURSOR_BOTTOM jumps to the last item in the focused pane", () => {
    let s: AppState = reducer(initialState, { type: "SET_LABELS", payload: fakeLabels });
    s = { ...s, focus: "sidebar" };
    s = reducer(s, { type: "CURSOR_BOTTOM" });
    expect(s.labelCursor).toBe(2); // 3 items, index 2
  });

  it("CLOSE_PANE walks message → threads → sidebar", () => {
    let s: AppState = {
      ...initialState,
      focus: "message",
      thread: { threadId: "t1", messageCount: 1, messages: [] },
    };
    s = reducer(s, { type: "CLOSE_PANE" });
    expect(s.focus).toBe("threads");
    expect(s.thread).toBeNull();
    s = reducer(s, { type: "CLOSE_PANE" });
    expect(s.focus).toBe("sidebar");
    s = reducer(s, { type: "CLOSE_PANE" });
    // Sidebar is the leftmost; further CLOSE_PANE is a no-op so the user
    // doesn't accidentally trigger a quit by mashing q.
    expect(s.focus).toBe("sidebar");
  });

  it("QUIT sets the quit flag for the App to read", () => {
    const s = reducer(initialState, { type: "QUIT" });
    expect(s.quit).toBe(true);
  });

  it("TOGGLE_HELP flips the overlay flag", () => {
    expect(initialState.showHelp).toBe(false);
    const s = reducer(initialState, { type: "TOGGLE_HELP" });
    expect(s.showHelp).toBe(true);
    const s2 = reducer(s, { type: "TOGGLE_HELP" });
    expect(s2.showHelp).toBe(false);
  });
});

describe("resolveKey", () => {
  it("matches single-char bindings immediately", () => {
    expect(resolveKey("", "j")).toEqual({ cmd: "cursor.down", pending: false });
    expect(resolveKey("", "Q")).toEqual({ cmd: "app.quit", pending: false });
  });

  it("buffers two-char prefixes like `gg`", () => {
    const first = resolveKey("", "g");
    expect(first.pending).toBe(true);
    expect(first.cmd).toBeNull();
    const second = resolveKey("g", "g");
    expect(second).toEqual({ cmd: "cursor.top", pending: false });
  });

  it("falls through to the single-key binding when the buffered prefix doesn't extend", () => {
    // Buffered "g" + "j" is not a known sequence — the `j` single-key still resolves.
    const result = resolveKey("g", "j");
    expect(result).toEqual({ cmd: "cursor.down", pending: false });
  });

  it("returns null for unknown keys without raising", () => {
    expect(resolveKey("", "@")).toEqual({ cmd: null, pending: false });
  });
});
