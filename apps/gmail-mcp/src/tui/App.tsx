// Root TUI component. Owns the reducer + input dispatcher + async data loads.
// Stays focused on wiring — heavy lifting lives in hooks/components.

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useReducer, useRef } from "react";
import { HelpBar } from "./components/HelpBar.js";
import { MessagePane } from "./components/MessagePane.js";
import { Sidebar } from "./components/Sidebar.js";
import { StatusBar } from "./components/StatusBar.js";
import { ThreadList } from "./components/ThreadList.js";
import * as gmail from "./hooks/useGmail.js";
import { defaultBindings, resolveKey } from "./keymap.js";
import { initialState, reducer } from "./reducer.js";
import type { Theme } from "./themes/index.js";

interface Props {
  theme: Theme;
}

export function App({ theme }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { exit } = useApp();
  const fetchingThread = useRef<string | null>(null);

  // Boot: load labels + initial inbox + account in parallel
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [labels, threads, accounts] = await Promise.all([
          gmail.listLabels(),
          gmail.listInboxThreads({ query: "in:inbox", maxResults: 50 }),
          gmail.listAccounts().catch(() => null),
        ]);
        if (cancelled) return;
        dispatch({ type: "SET_LABELS", payload: labels });
        dispatch({ type: "SET_THREADS", payload: threads });
        if (accounts) dispatch({ type: "SET_ACCOUNT", payload: accounts.active });
        dispatch({ type: "SET_STATUS", payload: `${threads.resultCount} threads` });
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: "SET_ERROR", payload: msg });
        dispatch({ type: "SET_STATUS", payload: `Error: ${msg}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Handle pending thread open
  useEffect(() => {
    if (!state.loading || state.focus !== "threads") return;
    const t = state.threads?.threads[state.threadCursor];
    if (!t) return;
    if (fetchingThread.current === t.threadId) return;
    fetchingThread.current = t.threadId;
    (async () => {
      try {
        const thread = await gmail.getThread(t.threadId);
        dispatch({ type: "SET_THREAD", payload: thread });
        dispatch({ type: "SET_LOADING", payload: false });
        dispatch({ type: "SET_STATUS", payload: `Thread: ${thread.messageCount} messages` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: "SET_ERROR", payload: msg });
        dispatch({ type: "SET_STATUS", payload: `Error: ${msg}` });
      } finally {
        fetchingThread.current = null;
      }
    })();
  }, [state.loading, state.focus, state.threadCursor, state.threads]);

  // Quit propagation
  useEffect(() => {
    if (state.quit) exit();
  }, [state.quit, exit]);

  // Input dispatcher — vim-modal. Session 1 implements normal mode only.
  useInput((input, key) => {
    if (state.mode !== "normal") return;
    // Synthesize a stable key name. Ink fires `input=""` + `key.return=true` etc.
    let keyName: string | null = null;
    if (key.return) keyName = "Enter";
    else if (key.tab) keyName = "Tab";
    else if (key.escape) keyName = "Escape";
    else if (input) keyName = input;
    if (!keyName) return;

    const { cmd, pending } = resolveKey(state.keyBuffer, keyName);
    if (pending) {
      dispatch({ type: "APPEND_KEY", payload: keyName });
      return;
    }
    if (state.keyBuffer) dispatch({ type: "CLEAR_KEY_BUFFER" });
    if (!cmd) return;

    switch (cmd) {
      case "app.quit":
        dispatch({ type: "QUIT" });
        return;
      case "cursor.down":
        dispatch({ type: "CURSOR_DOWN" });
        return;
      case "cursor.up":
        dispatch({ type: "CURSOR_UP" });
        return;
      case "cursor.top":
        dispatch({ type: "CURSOR_TOP" });
        return;
      case "cursor.bottom":
        dispatch({ type: "CURSOR_BOTTOM" });
        return;
      case "pane.open":
        if (state.focus === "threads") {
          dispatch({ type: "OPEN_THREAD" });
        } else if (state.focus === "sidebar") {
          // Selecting a label → jump to threads pane and trigger a reload.
          const items = state.labels ? [...state.labels.system, ...state.labels.user] : [];
          const label = items[state.labelCursor];
          if (label) {
            dispatch({ type: "SELECT_LABEL", payload: label.id });
            dispatch({ type: "SET_FOCUS", payload: "threads" });
            triggerLabelLoad(label.id, dispatch);
          }
        }
        return;
      case "pane.close":
        dispatch({ type: "CLOSE_PANE" });
        return;
      case "pane.cycle":
        cycleFocus(state.focus, dispatch);
        return;
      case "ui.help":
        dispatch({ type: "TOGGLE_HELP" });
        return;
      // Session 2 implements: ui.search, ui.command, msg.compose, msg.reply, …
      // Surfaces them as "not yet implemented" so users know they're wired.
      case "ui.search":
      case "ui.command":
      case "ui.stats":
      case "msg.reply":
      case "msg.reply-all":
      case "msg.compose":
      case "msg.draft.edit":
      case "msg.delete":
      case "msg.star":
      case "msg.read":
        dispatch({
          type: "SET_STATUS",
          payload: `${cmd}: coming in Phase D Session 2`,
        });
        return;
      default:
        return;
    }
  });

  const accountChip = state.account?.id ?? null;

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Main 3-pane row */}
      <Box flexDirection="row" flexGrow={1}>
        <Sidebar
          labels={state.labels}
          cursor={state.labelCursor}
          focused={state.focus === "sidebar"}
          selectedLabelId={state.selectedLabelId}
          theme={theme}
        />
        {state.focus === "message" && state.thread ? (
          <MessagePane
            thread={state.thread}
            cursor={state.messageCursor}
            focused={state.focus === "message"}
            theme={theme}
          />
        ) : (
          <ThreadList
            threads={state.threads}
            cursor={state.threadCursor}
            focused={state.focus === "threads"}
            theme={theme}
            title={labelTitle(state)}
          />
        )}
      </Box>
      {state.showHelp ? <HelpOverlay theme={theme} /> : null}
      <StatusBar
        mode={state.mode}
        status={state.error ? `Error: ${state.error}` : state.status}
        account={accountChip}
        theme={theme}
      />
      <HelpBar focus={state.focus} theme={theme} />
    </Box>
  );
}

function HelpOverlay({ theme }: { theme: Theme }) {
  return (
    <Box
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={theme.accent}
    >
      <Text color={theme.accent} bold>
        Keybindings
      </Text>
      {defaultBindings.map((b) => (
        <Text key={b.keys} color={theme.fg}>
          {`  ${b.keys.padEnd(8)} ${b.desc}`}
        </Text>
      ))}
      <Text color={theme.dim}>{`  Press ? to close`}</Text>
    </Box>
  );
}

function cycleFocus(
  current: string,
  dispatch: (a: { type: "SET_FOCUS"; payload: "sidebar" | "threads" | "message" }) => void,
) {
  if (current === "sidebar") dispatch({ type: "SET_FOCUS", payload: "threads" });
  else if (current === "threads") dispatch({ type: "SET_FOCUS", payload: "message" });
  else dispatch({ type: "SET_FOCUS", payload: "sidebar" });
}

function labelTitle(state: {
  selectedLabelId: string;
  threads: { resultCount: number } | null;
}): string {
  const count = state.threads?.resultCount ?? 0;
  const niceName =
    state.selectedLabelId === "INBOX"
      ? "Inbox"
      : state.selectedLabelId === "STARRED"
        ? "Starred"
        : state.selectedLabelId === "SENT"
          ? "Sent"
          : state.selectedLabelId === "DRAFT"
            ? "Drafts"
            : state.selectedLabelId;
  return `${niceName}  (${count})`;
}

function triggerLabelLoad(
  labelId: string,
  dispatch: (
    a:
      | { type: "SET_THREADS"; payload: import("./reducer.js").ThreadList }
      | { type: "SET_STATUS"; payload: string }
      | { type: "SET_ERROR"; payload: string | null },
  ) => void,
) {
  const query = labelId === "INBOX" ? "in:inbox" : `label:${labelId}`;
  (async () => {
    try {
      const threads = await gmail.listInboxThreads({ query, maxResults: 50 });
      dispatch({ type: "SET_THREADS", payload: threads });
      dispatch({ type: "SET_STATUS", payload: `${threads.resultCount} threads` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "SET_ERROR", payload: msg });
    }
  })();
}
