// Root TUI component. Owns the reducer + input dispatcher + async data loads.
// Stays focused on wiring — heavy lifting lives in hooks/components.

import { Box, Text, useApp, useInput, useStdin } from "ink";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { type AccountChangedPayload, sessionEvents } from "../core/session.js";
import { AccountSwitcher } from "./components/AccountSwitcher.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ConfirmModal } from "./components/ConfirmModal.js";
import { DevStatsModal } from "./components/DevStatsModal.js";
import { HelpBar } from "./components/HelpBar.js";
import { MessagePane } from "./components/MessagePane.js";
import { SearchBar } from "./components/SearchBar.js";
import { Sidebar } from "./components/Sidebar.js";
import { StatusBar } from "./components/StatusBar.js";
import { ThemePicker } from "./components/ThemePicker.js";
import { ThreadList } from "./components/ThreadList.js";
import { buildComposeTemplate, parseCompose, quoteReplyBody } from "./compose-parser.js";
import { type TuiConfig } from "./config.js";
import { accountScopedCacheKey, defaultCacheBytes, LruCache } from "./hooks/useCache.js";
import { useDevStats } from "./hooks/useDevStats.js";
import { createEditorOpener, resolveEditor } from "./hooks/useEditor.js";
import * as gmail from "./hooks/useGmail.js";
import { defaultBindings, resolveKey } from "./keymap.js";
import { type Action, initialState, reducer } from "./reducer.js";
import { listThemeNames, loadTheme, type Theme } from "./themes/index.js";

interface Props {
  initialTheme: Theme;
  config: TuiConfig;
}

export function App({ initialTheme, config }: Props) {
  const [state, dispatch] = useReducer(reducer, { ...initialState, themeName: initialTheme.name });
  const { exit } = useApp();
  const { setRawMode } = useStdin();
  const fetchingThread = useRef<string | null>(null);
  const openEditorRef = useRef(createEditorOpener(setRawMode));
  const threadCacheRef = useRef(
    new LruCache<gmail.ScopedThreadView>(config.cacheMB * 1024 * 1024 || defaultCacheBytes()),
  );
  const theme = loadTheme(state.themeName);

  // Stable stats reader — useDevStats polls this each tick.
  const cacheStats = useCallback(() => threadCacheRef.current.stats(), []);
  const stats = useDevStats({
    enabled: state.showStats,
    intervalMs: 1000,
    cache: cacheStats,
    themeName: state.themeName,
    editor: config.editor ?? resolveEditor(),
  });

  // Subscribe to mid-session account swaps so the sidebar/inbox refresh.
  useEffect(() => {
    const onChange = (payload: AccountChangedPayload) => {
      const nextScope = { kind: "single" as const, accountId: payload.current };
      threadCacheRef.current.clear();
      dispatch({ type: "SET_SCOPE", payload: nextScope });
      (async () => {
        try {
          await reloadScope(nextScope, dispatch);
        } catch (err) {
          dispatch({
            type: "SET_ERROR",
            payload: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    };
    sessionEvents.on("accountChanged", onChange);
    return () => {
      sessionEvents.off("accountChanged", onChange);
    };
  }, []);

  // Boot: load labels + initial inbox + account in parallel
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const accounts = await gmail.listAccounts().catch(() => null);
        if (cancelled) return;
        const bootScope = { kind: "single" as const, accountId: accounts?.active.id ?? null };
        if (accounts) {
          dispatch({ type: "SET_ACCOUNT", payload: accounts.active });
          dispatch({ type: "SET_ACCOUNT_LIST", payload: accounts });
        }
        dispatch({ type: "SET_SCOPE", payload: bootScope });
        await reloadScope(bootScope, dispatch);
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

  // Handle pending thread open — cache hit returns instantly; miss fetches.
  useEffect(() => {
    if (!state.loading || state.focus !== "threads") return;
    const t = state.threads?.threads[state.threadCursor];
    if (!t) return;
    const accountId =
      t.accountId ?? (state.scope.kind === "single" ? state.scope.accountId : state.account?.id);
    const cacheKey = accountScopedCacheKey(accountId, t.threadId);
    if (fetchingThread.current === cacheKey) return;
    const cached = threadCacheRef.current.get(cacheKey);
    if (cached) {
      dispatch({ type: "SET_THREAD", payload: cached });
      dispatch({ type: "SET_LOADING", payload: false });
      dispatch({ type: "SET_STATUS", payload: `Thread (cached): ${cached.messageCount} messages` });
      return;
    }
    fetchingThread.current = cacheKey;
    (async () => {
      try {
        const thread = await gmail.getThreadForScope(t.threadId, accountId);
        threadCacheRef.current.put(cacheKey, thread);
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
  }, [state.loading, state.focus, state.threadCursor, state.threads, state.scope, state.account]);

  // Editor suspension — runs whenever pendingEditor flips on.
  useEffect(() => {
    const intent = state.pendingEditor;
    if (!intent) return;
    let cancelled = false;
    (async () => {
      try {
        dispatch({ type: "SET_STATUS", payload: `Opening $EDITOR (${intent.kind})…` });
        const result = await openEditorRef.current({ initialContent: intent.initialContent });
        if (cancelled) return;
        if (!result.content) {
          dispatch({ type: "SET_STATUS", payload: "Compose aborted." });
          dispatch({ type: "CLEAR_EDITOR" });
          return;
        }
        const parsed = parseCompose(result.content);
        if (intent.kind === "reply-all") {
          if (!intent.sourceMessageId) {
            dispatch({ type: "SET_STATUS", payload: "reply-all: missing source message id" });
            dispatch({ type: "CLEAR_EDITOR" });
            return;
          }
          await gmail.replyAll({ messageId: intent.sourceMessageId, body: parsed.body });
          dispatch({ type: "SET_STATUS", payload: "Reply sent (reply-all)" });
        } else if (intent.kind === "draft-edit") {
          if (parsed.to.length === 0 || !parsed.subject) {
            dispatch({
              type: "SET_STATUS",
              payload: "Draft saved without send (missing To/Subject)",
            });
          }
          await gmail.draftEmail({
            to: parsed.to,
            cc: parsed.cc,
            bcc: parsed.bcc,
            subject: parsed.subject,
            body: parsed.body,
            threadId: intent.sourceThreadId,
          });
          dispatch({ type: "SET_STATUS", payload: "Draft saved" });
        } else {
          // compose / reply both call send_email
          if (parsed.to.length === 0) {
            dispatch({ type: "SET_STATUS", payload: "Aborted: To: header empty." });
            dispatch({ type: "CLEAR_EDITOR" });
            return;
          }
          await gmail.sendEmail({
            to: parsed.to,
            cc: parsed.cc,
            bcc: parsed.bcc,
            subject: parsed.subject,
            body: parsed.body,
            threadId: intent.sourceThreadId,
            inReplyTo: intent.sourceMessageId,
          });
          dispatch({
            type: "SET_STATUS",
            payload: intent.kind === "reply" ? "Reply sent" : "Email sent",
          });
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: "SET_ERROR", payload: msg });
      } finally {
        dispatch({ type: "CLEAR_EDITOR" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.pendingEditor]);

  // Quit propagation
  useEffect(() => {
    if (state.quit) exit();
  }, [state.quit, exit]);

  // Input dispatcher — vim-modal. Insert / command modes feed the overlay.
  useInput((input, key) => {
    // Confirm modal: y/n/Esc regardless of mode.
    if (state.overlay.kind === "confirm") {
      if (input === "y" || input === "Y") {
        runConfirmedCmd(state.overlay.pendingCmd, state, dispatch);
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        dispatch({ type: "CLOSE_OVERLAY" });
        dispatch({ type: "SET_STATUS", payload: "Aborted." });
        return;
      }
      return;
    }
    // Account switcher: j/k navigate, Enter applies, Esc closes.
    if (state.overlay.kind === "account") {
      if (key.escape) {
        dispatch({ type: "CLOSE_OVERLAY" });
        return;
      }
      if (input === "j") {
        dispatch({ type: "CURSOR_DOWN" });
        return;
      }
      if (input === "k") {
        dispatch({ type: "CURSOR_UP" });
        return;
      }
      if (input === " ") {
        const items = state.accountList?.accounts ?? [];
        const target = items[state.overlay.cursor - 1];
        if (!target) return;
        const selectedIds = new Set(state.overlay.selectedIds ?? []);
        if (selectedIds.has(target.id)) selectedIds.delete(target.id);
        else selectedIds.add(target.id);
        dispatch({
          type: "OPEN_OVERLAY",
          payload: {
            kind: "account",
            cursor: state.overlay.cursor,
            selectedIds: [...selectedIds],
          },
        });
        return;
      }
      if (key.return) {
        const items = state.accountList?.accounts ?? [];
        if (state.overlay.cursor === 0) {
          applyBrowseScope({ kind: "all" }, dispatch, threadCacheRef.current);
          dispatch({ type: "CLOSE_OVERLAY" });
          return;
        }
        const selectedIds = state.overlay.selectedIds ?? [];
        if (selectedIds.length > 1) {
          applyBrowseScope(
            { kind: "selected", accountIds: selectedIds },
            dispatch,
            threadCacheRef.current,
          );
          dispatch({ type: "CLOSE_OVERLAY" });
          return;
        }
        const target = items[state.overlay.cursor - 1];
        if (target)
          requestSwitchAccount(target.id, target.isActive, dispatch, threadCacheRef.current);
        dispatch({ type: "CLOSE_OVERLAY" });
        return;
      }
      return;
    }
    // Theme picker: j/k navigate, Enter applies, Esc closes.
    if (state.overlay.kind === "theme") {
      if (key.escape) {
        dispatch({ type: "CLOSE_OVERLAY" });
        return;
      }
      if (input === "j") {
        dispatch({ type: "CURSOR_DOWN" });
        return;
      }
      if (input === "k") {
        dispatch({ type: "CURSOR_UP" });
        return;
      }
      if (key.return) {
        const names = listThemeNames();
        const name = names[state.overlay.cursor];
        if (name) {
          dispatch({ type: "SET_THEME", payload: name });
          dispatch({ type: "SET_STATUS", payload: `Theme → ${name}` });
        }
        dispatch({ type: "CLOSE_OVERLAY" });
        return;
      }
      return;
    }
    // Insert mode (search / command palette): characters extend the buffer.
    if (state.mode === "insert") {
      if (key.escape) {
        dispatch({ type: "CLOSE_OVERLAY" });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "OVERLAY_BACKSPACE" });
        return;
      }
      if (key.return) {
        runOverlay(state, dispatch);
        return;
      }
      if (input) {
        dispatch({ type: "OVERLAY_INPUT", payload: input });
      }
      return;
    }
    // Normal mode
    if (state.mode !== "normal") return;
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

    runNormalCmd(cmd, state, dispatch);
  });

  const accountChip = tuiScopeLabel(state.scope, state.account?.id ?? null);

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
      {state.overlay.kind === "confirm" ? (
        <ConfirmModal prompt={state.overlay.prompt} theme={theme} />
      ) : null}
      {state.overlay.kind === "theme" ? (
        <ThemePicker cursor={state.overlay.cursor} current={state.themeName} theme={theme} />
      ) : null}
      {state.overlay.kind === "command" ? (
        <CommandPalette text={state.overlay.text} theme={theme} />
      ) : null}
      {state.overlay.kind === "search" ? (
        <SearchBar text={state.overlay.text} theme={theme} />
      ) : null}
      {state.overlay.kind === "account" ? (
        <AccountSwitcher
          list={state.accountList}
          cursor={state.overlay.cursor}
          selectedIds={state.overlay.selectedIds}
          theme={theme}
        />
      ) : null}
      {state.showStats ? <DevStatsModal stats={stats} theme={theme} /> : null}
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

function tuiScopeLabel(
  scope: import("./reducer.js").BrowseScope,
  activeAccountId: string | null,
): string | null {
  if (scope.kind === "all") return "all";
  if (scope.kind === "selected") return `selected:${scope.accountIds.join(",")}`;
  return scope.accountId ?? activeAccountId;
}

async function reloadScope(
  scope: import("./reducer.js").BrowseScope,
  dispatch: (a: Action) => void,
  query = "in:inbox",
) {
  const [labels, threads, accounts] = await Promise.all([
    gmail.listLabelsForScope(scope),
    gmail.listInboxThreadsForScope(scope, { query, maxResults: 50 }),
    gmail.listAccounts().catch(() => null),
  ]);
  dispatch({ type: "SET_LABELS", payload: labels });
  dispatch({ type: "SET_THREADS", payload: threads });
  if (accounts) {
    dispatch({ type: "SET_ACCOUNT", payload: accounts.active });
    dispatch({ type: "SET_ACCOUNT_LIST", payload: accounts });
  }
  dispatch({ type: "SET_STATUS", payload: `${threads.resultCount} threads` });
}

function triggerLabelLoad(
  labelId: string,
  scope: import("./reducer.js").BrowseScope,
  dispatch: (a: Action) => void,
) {
  const query = labelId === "INBOX" ? "in:inbox" : `label:${labelId}`;
  (async () => {
    try {
      const threads = await gmail.listInboxThreadsForScope(scope, { query, maxResults: 50 });
      dispatch({ type: "SET_THREADS", payload: threads });
      dispatch({ type: "SET_STATUS", payload: `${threads.resultCount} threads` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "SET_ERROR", payload: msg });
    }
  })();
}

function runSearch(
  query: string,
  scope: import("./reducer.js").BrowseScope,
  dispatch: (a: Action) => void,
) {
  if (!query) return;
  (async () => {
    dispatch({ type: "SET_STATUS", payload: `Searching: ${query}` });
    try {
      const threads = await gmail.listInboxThreadsForScope(scope, { query, maxResults: 50 });
      dispatch({ type: "SET_THREADS", payload: threads });
      dispatch({ type: "SET_STATUS", payload: `${threads.resultCount} matches` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: "SET_ERROR", payload: msg });
    }
  })();
}

function runOverlay(state: import("./reducer.js").AppState, dispatch: (a: Action) => void) {
  if (state.overlay.kind === "search") {
    const q = state.overlay.text.trim();
    dispatch({ type: "CLOSE_OVERLAY" });
    if (q) runSearch(q, state.scope, dispatch);
    return;
  }
  if (state.overlay.kind === "command") {
    const raw = state.overlay.text.trim();
    dispatch({ type: "CLOSE_OVERLAY" });
    runExCommand(raw, state, dispatch);
  }
}

function runExCommand(
  raw: string,
  state: import("./reducer.js").AppState,
  dispatch: (a: Action) => void,
) {
  if (!raw) return;
  const [head, ...rest] = raw.split(/\s+/);
  const arg = rest.join(" ");
  switch (head) {
    case "q":
    case "quit":
      dispatch({ type: "QUIT" });
      return;
    case "help":
      dispatch({ type: "TOGGLE_HELP" });
      return;
    case "theme":
      if (arg) {
        const names = listThemeNames();
        if (!names.includes(arg)) {
          dispatch({ type: "SET_STATUS", payload: `Unknown theme: ${arg}` });
          return;
        }
        dispatch({ type: "SET_THEME", payload: arg });
        dispatch({ type: "SET_STATUS", payload: `Theme → ${arg}` });
      } else {
        const currentIdx = Math.max(0, listThemeNames().indexOf(state.themeName));
        dispatch({ type: "OPEN_OVERLAY", payload: { kind: "theme", cursor: currentIdx } });
      }
      return;
    case "search":
      if (arg) runSearch(arg, state.scope, dispatch);
      return;
    case "label":
      if (arg) {
        dispatch({ type: "SELECT_LABEL", payload: arg });
        triggerLabelLoad(arg, state.scope, dispatch);
      }
      return;
    case "health":
      runHealthCheck(dispatch);
      return;
    case "stats":
      dispatch({ type: "TOGGLE_STATS" });
      return;
    case "account":
      openAccountSwitcher(state, dispatch);
      return;
    default:
      dispatch({ type: "SET_STATUS", payload: `Unknown command: ${head}` });
  }
}

function runNormalCmd(
  cmd: string,
  state: import("./reducer.js").AppState,
  dispatch: (a: Action) => void,
) {
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
        const items = state.labels ? [...state.labels.system, ...state.labels.user] : [];
        const label = items[state.labelCursor];
        if (label) {
          dispatch({ type: "SELECT_LABEL", payload: label.id });
          dispatch({ type: "SET_FOCUS", payload: "threads" });
          triggerLabelLoad(label.id, state.scope, dispatch);
        }
      }
      return;
    case "pane.close":
      dispatch({ type: "CLOSE_PANE" });
      return;
    case "pane.cycle":
      dispatch({
        type: "SET_FOCUS",
        payload:
          state.focus === "sidebar" ? "threads" : state.focus === "threads" ? "message" : "sidebar",
      });
      return;
    case "ui.help":
      dispatch({ type: "TOGGLE_HELP" });
      return;
    case "ui.search":
      dispatch({ type: "OPEN_OVERLAY", payload: { kind: "search", text: "" } });
      return;
    case "ui.command":
      dispatch({ type: "OPEN_OVERLAY", payload: { kind: "command", text: "" } });
      return;
    case "ui.stats":
      dispatch({ type: "TOGGLE_STATS" });
      return;
    case "msg.compose":
      if (!ensureSingleScope(state, dispatch)) return;
      dispatch({
        type: "REQUEST_EDITOR",
        payload: { kind: "compose", initialContent: buildComposeTemplate({}) },
      });
      return;
    case "msg.reply":
      if (!ensureSingleScope(state, dispatch)) return;
      requestReply(state, "reply", dispatch);
      return;
    case "msg.reply-all":
      if (!ensureSingleScope(state, dispatch)) return;
      requestReply(state, "reply-all", dispatch);
      return;
    case "msg.draft.edit":
      if (!ensureSingleScope(state, dispatch)) return;
      // For MVP, treat as "open compose form for a new draft" — selecting an
      // existing draft for in-place editing comes in Session 3 when the
      // drafts label is first-class.
      dispatch({
        type: "REQUEST_EDITOR",
        payload: { kind: "draft-edit", initialContent: buildComposeTemplate({}) },
      });
      return;
    case "msg.delete": {
      if (!ensureSingleScope(state, dispatch)) return;
      const msg = currentMessage(state);
      if (!msg) {
        dispatch({ type: "SET_STATUS", payload: "No message selected." });
        return;
      }
      dispatch({
        type: "OPEN_OVERLAY",
        payload: {
          kind: "confirm",
          prompt: `Permanently delete "${msg.subject || "(no subject)"}"?`,
          pendingCmd: `delete:${msg.messageId}`,
        },
      });
      return;
    }
    case "msg.star":
      if (!ensureSingleScope(state, dispatch)) return;
      toggleStar(state, dispatch);
      return;
    case "msg.read":
      if (!ensureSingleScope(state, dispatch)) return;
      toggleRead(state, dispatch);
      return;
    default:
      return;
  }
}

function currentMessage(state: import("./reducer.js").AppState) {
  return state.thread?.messages[state.messageCursor] ?? null;
}

function ensureSingleScope(
  state: import("./reducer.js").AppState,
  dispatch: (a: Action) => void,
): boolean {
  if (state.scope.kind === "single") return true;
  dispatch({ type: "SET_STATUS", payload: "Switch to one account before modifying messages." });
  return false;
}

function requestReply(
  state: import("./reducer.js").AppState,
  kind: "reply" | "reply-all",
  dispatch: (a: Action) => void,
) {
  const msg = currentMessage(state);
  if (!msg) {
    dispatch({ type: "SET_STATUS", payload: "Open a thread before replying." });
    return;
  }
  const quoted = quoteReplyBody(msg.from, msg.date, msg.body);
  const subject = msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`;
  const template =
    kind === "reply-all"
      ? // reply_all op builds recipients server-side, so the editor just
        // needs the body. We still surface To/Subject for context.
        `To: (auto)\nSubject: ${subject}\n\n${quoted}`
      : buildComposeTemplate({ to: [msg.from], subject, body: quoted });
  dispatch({
    type: "REQUEST_EDITOR",
    payload: {
      kind,
      initialContent: template,
      sourceMessageId: msg.messageId,
      sourceThreadId: msg.threadId,
    },
  });
}

function toggleStar(state: import("./reducer.js").AppState, dispatch: (a: Action) => void) {
  const msg = currentMessage(state);
  if (!msg) {
    dispatch({ type: "SET_STATUS", payload: "No message selected." });
    return;
  }
  const isStarred = msg.labelIds.includes("STARRED");
  const args = isStarred
    ? { messageId: msg.messageId, removeLabelIds: ["STARRED"] }
    : { messageId: msg.messageId, addLabelIds: ["STARRED"] };
  (async () => {
    try {
      await gmail.modifyEmail(args);
      dispatch({ type: "SET_STATUS", payload: isStarred ? "Unstarred" : "Starred" });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function toggleRead(state: import("./reducer.js").AppState, dispatch: (a: Action) => void) {
  const msg = currentMessage(state);
  if (!msg) {
    dispatch({ type: "SET_STATUS", payload: "No message selected." });
    return;
  }
  const isUnread = msg.labelIds.includes("UNREAD");
  const args = isUnread
    ? { messageId: msg.messageId, removeLabelIds: ["UNREAD"] }
    : { messageId: msg.messageId, addLabelIds: ["UNREAD"] };
  (async () => {
    try {
      await gmail.modifyEmail(args);
      dispatch({ type: "SET_STATUS", payload: isUnread ? "Marked read" : "Marked unread" });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function openAccountSwitcher(
  state: import("./reducer.js").AppState,
  dispatch: (a: Action) => void,
) {
  const activeIdx = Math.max(0, state.accountList?.accounts.findIndex((a) => a.isActive) ?? 0);
  const selectedIds =
    state.scope.kind === "selected"
      ? state.scope.accountIds
      : state.scope.kind === "single" && state.scope.accountId
        ? [state.scope.accountId]
        : [];
  dispatch({
    type: "OPEN_OVERLAY",
    payload: { kind: "account", cursor: activeIdx + 1, selectedIds },
  });
  // Refresh asynchronously so the list reflects the latest state.
  (async () => {
    try {
      const list = await gmail.listAccounts();
      dispatch({ type: "SET_ACCOUNT_LIST", payload: list });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function applyBrowseScope(
  scope: import("./reducer.js").BrowseScope,
  dispatch: (a: Action) => void,
  threadCache: LruCache<gmail.ScopedThreadView>,
) {
  threadCache.clear();
  dispatch({ type: "SET_SCOPE", payload: scope });
  (async () => {
    try {
      await reloadScope(scope, dispatch);
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function requestSwitchAccount(
  accountId: string,
  alreadyActive: boolean,
  dispatch: (a: Action) => void,
  threadCache?: LruCache<gmail.ScopedThreadView>,
) {
  if (alreadyActive) {
    if (threadCache) {
      applyBrowseScope({ kind: "single", accountId }, dispatch, threadCache);
    } else {
      dispatch({ type: "SET_SCOPE", payload: { kind: "single", accountId } });
    }
    return;
  }
  (async () => {
    try {
      dispatch({ type: "SET_STATUS", payload: `Switching to ${accountId}…` });
      const result = await gmail.switchAccount(accountId);
      // sessionEvents.accountChanged will fire from setSession inside the op —
      // the subscribed listener in App refreshes labels/threads/account.
      dispatch({
        type: "SET_STATUS",
        payload: `Switched ${result.previousAccountId ?? "(none)"} → ${result.newAccountId}`,
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function runHealthCheck(dispatch: (a: Action) => void) {
  (async () => {
    try {
      const { callOp } = await import("../cli/runtime.js");
      const res = await callOp<{ status: string; issues: string[] }>("health_check", {});
      dispatch({
        type: "SET_STATUS",
        payload: `Health: ${res.status}${res.issues.length ? ` — ${res.issues.join(", ")}` : ""}`,
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function runConfirmedCmd(
  pendingCmd: string,
  state: import("./reducer.js").AppState,
  dispatch: (a: Action) => void,
) {
  void state;
  dispatch({ type: "CLOSE_OVERLAY" });
  const [verb, ...rest] = pendingCmd.split(":");
  if (verb === "delete") {
    const id = rest.join(":");
    if (!id) {
      dispatch({ type: "SET_STATUS", payload: "Delete: missing id." });
      return;
    }
    (async () => {
      try {
        await gmail.deleteEmail(id);
        dispatch({ type: "SET_STATUS", payload: "Message deleted." });
      } catch (err) {
        dispatch({
          type: "SET_ERROR",
          payload: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return;
  }
  dispatch({ type: "SET_STATUS", payload: `Unknown confirm cmd: ${pendingCmd}` });
}
