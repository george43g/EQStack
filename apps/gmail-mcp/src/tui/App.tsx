// Root TUI component. Owns the reducer + input dispatcher + async data loads.
// Stays focused on wiring — heavy lifting lives in hooks/components.

import { Box, useApp, useInput, useStdin } from "ink";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { type AccountChangedPayload, sessionEvents } from "../core/session.js";
import { AccountSwitcher } from "./components/AccountSwitcher.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ConfirmModal } from "./components/ConfirmModal.js";
import { DevStatsModal } from "./components/DevStatsModal.js";
import { HelpBar } from "./components/HelpBar.js";
import { HelpModal } from "./components/HelpModal.js";
import { LabelOverlay } from "./components/LabelOverlay.js";
import { MessageDetailPane } from "./components/MessageDetailPane.js";
import { MessageListPane } from "./components/MessageListPane.js";
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
import { resolveKey } from "./keymap.js";
import { type Action, initialState, reducer } from "./reducer.js";
import { listThemeNames, loadTheme, type Theme } from "./themes/index.js";

// Eager-load debounce: too short and we flood the API on cursor-spam (10j);
// too long and the user doesn't perceive the prefetch. 250ms matches the
// common "pause vs scroll" threshold used by file managers (ranger / yazi)
// and feels instantaneous when the user actually opens the thread.
const EAGER_FETCH_DELAY_MS = 250;

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

  // Eager pre-fetch: when the user lingers on a thread row for >250ms, kick
  // off a background fetch so pressing Enter / l is instant. Aborts cleanly
  // if the cursor moves before the timer fires OR before the fetch resolves
  // (the LRU cache absorbs the result if it arrives, but the focused thread
  // by then may have changed).
  //
  // Only fires when the user is BROWSING (focus="threads", not loading).
  // The cache key is scoped per account so a switch between accounts keeps
  // both pre-fetches independent.
  useEffect(() => {
    if (state.focus !== "threads" || state.loading) return;
    const t = state.threads?.threads[state.threadCursor];
    if (!t) return;
    const accountId =
      t.accountId ?? (state.scope.kind === "single" ? state.scope.accountId : state.account?.id);
    const cacheKey = accountScopedCacheKey(accountId, t.threadId);
    // Already cached or in-flight → nothing to do.
    if (threadCacheRef.current.has(cacheKey)) return;
    if (fetchingThread.current === cacheKey) return;

    const abort = new AbortController();
    const timer = setTimeout(() => {
      // Re-check inside the timer — cursor may have moved between schedule
      // and fire (React batches state updates), and the cleanup may not have
      // run yet for the trailing tick.
      if (abort.signal.aborted) return;
      if (threadCacheRef.current.has(cacheKey)) return;
      if (fetchingThread.current === cacheKey) return;
      (async () => {
        try {
          const thread = await gmail.getThreadForScope(t.threadId, accountId, abort.signal);
          if (abort.signal.aborted) return;
          // Park in the cache — DO NOT dispatch SET_THREAD: that would flip
          // focus to "message" without the user's consent. The next pane.open
          // for this id hits the cache and lands instantly.
          threadCacheRef.current.put(cacheKey, thread);
        } catch {
          // Eager fetches are best-effort; silently swallow errors (the user
          // hasn't committed to opening this thread yet, so an error here
          // would be noise). If they do press Enter, the foreground effect
          // will refetch and surface the error properly.
        }
      })();
    }, EAGER_FETCH_DELAY_MS);

    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [state.focus, state.loading, state.threadCursor, state.threads, state.scope, state.account]);

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
    // Help modal: text input feeds the fuzzy filter, j/k navigates filtered
    // hits, Esc clears filter then closes, ?/Enter close. Highest priority
    // because it shadows all normal-mode bindings while open.
    if (state.showHelp) {
      if (key.escape) {
        // Esc clears the filter first (sesh-style); a second Esc closes help.
        if (state.helpFilter.length > 0) {
          dispatch({ type: "HELP_RESET" });
        } else {
          dispatch({ type: "TOGGLE_HELP" });
        }
        return;
      }
      if (input === "?" || key.return) {
        dispatch({ type: "TOGGLE_HELP" });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "HELP_FILTER_BACKSPACE" });
        return;
      }
      if (state.helpFilter.length > 0 && (input === "j" || key.downArrow)) {
        dispatch({ type: "HELP_CURSOR_MOVE", payload: +1 });
        return;
      }
      if (state.helpFilter.length > 0 && (input === "k" || key.upArrow)) {
        dispatch({ type: "HELP_CURSOR_MOVE", payload: -1 });
        return;
      }
      if (input && !key.ctrl) {
        dispatch({ type: "HELP_FILTER_INPUT", payload: input });
      }
      return;
    }
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
    // Ctrl-prefixed keys are surfaced to the registry as "C-<lowercase>" so
    // the keymap can declare them uniformly (e.g. `C-d` for half-page-down).
    else if (key.ctrl && input) keyName = `C-${input.toLowerCase()}`;
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

  // Centered modals take over the main view region — the 3-pane row is hidden
  // while one is active. Without takeover, Ink's diff renderer leaves the
  // panes' previous-frame cells visible behind the modal (`<Box>` in Ink 7
  // ignores `backgroundColor`, so a bordered box without takeover bleeds).
  // CommandPalette + SearchBar are bottom-bar overlays — they coexist with
  // the 3-pane row and are unaffected.
  const centeredModalActive =
    state.showHelp ||
    state.showStats ||
    state.overlay.kind === "confirm" ||
    state.overlay.kind === "theme" ||
    state.overlay.kind === "account";

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {centeredModalActive ? (
        <>
          {state.showHelp ? (
            <HelpOverlay theme={theme} filter={state.helpFilter} cursor={state.helpCursor} />
          ) : null}
          {state.overlay.kind === "confirm" ? (
            <ConfirmModal prompt={state.overlay.prompt} theme={theme} />
          ) : null}
          {state.overlay.kind === "theme" ? (
            <ThemePicker cursor={state.overlay.cursor} current={state.themeName} theme={theme} />
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
        </>
      ) : (
        // Drill-down panes: Sidebar (always) | ThreadList | MessageListPane
        // | MessageDetailPane. The two right-most appear progressively as
        // the user drills via `l` / Enter (focus advances threads → message
        // → view) and collapse with `h`.
        <Box flexDirection="row" flexGrow={1}>
          <Sidebar
            labels={state.labels}
            cursor={state.labelCursor}
            focused={state.focus === "sidebar"}
            selectedLabelId={state.selectedLabelId}
            theme={theme}
          />
          {/* ThreadList is hidden once the user drills into a single message
              view — frees the horizontal space for the body. */}
          {state.focus !== "view" ? (
            <ThreadList
              threads={state.threads}
              cursor={state.threadCursor}
              focused={state.focus === "threads"}
              theme={theme}
              title={labelTitle(state)}
            />
          ) : null}
          {state.thread ? (
            <MessageListPane
              thread={state.thread}
              cursor={state.messageCursor}
              focused={state.focus === "message"}
              theme={theme}
            />
          ) : null}
          {state.focus === "view" && state.thread ? (
            // Force a remount whenever the message switches — Ink 7's diff
            // renderer leaves cell artifacts when the pane's content shape
            // shifts and a fresh mount guarantees a full repaint. Scroll
            // intentionally NOT in the key — that would unmount on every
            // j/k tick and lose render performance / scroll smoothness.
            <MessageDetailPane
              key={`view-${state.thread.threadId}-${state.messageCursor}`}
              thread={state.thread}
              cursor={state.messageCursor}
              focused={true}
              theme={theme}
              bodyScroll={state.bodyScroll}
            />
          ) : null}
        </Box>
      )}
      {state.overlay.kind === "command" ? (
        <CommandPalette text={state.overlay.text} theme={theme} />
      ) : null}
      {state.overlay.kind === "search" ? (
        <SearchBar text={state.overlay.text} theme={theme} />
      ) : null}
      {state.overlay.kind === "label" ? (
        <LabelOverlay mode={state.overlay.mode} text={state.overlay.text} theme={theme} />
      ) : null}
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

function HelpOverlay({ theme, filter, cursor }: { theme: Theme; filter: string; cursor: number }) {
  return <HelpModal theme={theme} filter={filter} cursor={cursor} />;
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
    return;
  }
  if (state.overlay.kind === "label") {
    const labelName = state.overlay.text.trim();
    const mode = state.overlay.mode;
    dispatch({ type: "CLOSE_OVERLAY" });
    if (labelName) runLabelMutation(labelName, mode, state, dispatch);
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
      if (state.focus === "view") dispatch({ type: "BODY_SCROLL", payload: +1 });
      else dispatch({ type: "CURSOR_DOWN" });
      return;
    case "cursor.up":
      if (state.focus === "view") dispatch({ type: "BODY_SCROLL", payload: -1 });
      else dispatch({ type: "CURSOR_UP" });
      return;
    case "cursor.top":
      if (state.focus === "view") dispatch({ type: "BODY_SCROLL_ABS", payload: 0 });
      else dispatch({ type: "CURSOR_TOP" });
      return;
    case "cursor.bottom":
      if (state.focus === "view") dispatch({ type: "BODY_SCROLL_ABS", payload: "end" });
      else dispatch({ type: "CURSOR_BOTTOM" });
      return;
    case "cursor.middle":
      dispatch({ type: "CURSOR_MIDDLE" });
      return;
    case "cursor.half-page-down":
      if (state.focus === "view") dispatch({ type: "BODY_SCROLL", payload: +halfPageStep() });
      else dispatch({ type: "CURSOR_MOVE", payload: +halfPageStep() });
      return;
    case "cursor.half-page-up":
      if (state.focus === "view") dispatch({ type: "BODY_SCROLL", payload: -halfPageStep() });
      else dispatch({ type: "CURSOR_MOVE", payload: -halfPageStep() });
      return;
    case "cursor.page-down":
      if (state.focus === "view") dispatch({ type: "BODY_SCROLL", payload: +pageStep() });
      else dispatch({ type: "CURSOR_MOVE", payload: +pageStep() });
      return;
    case "cursor.page-up":
      if (state.focus === "view") dispatch({ type: "BODY_SCROLL", payload: -pageStep() });
      else dispatch({ type: "CURSOR_MOVE", payload: -pageStep() });
      return;
    case "nav.folder.inbox":
    case "nav.folder.sent":
    case "nav.folder.drafts":
    case "nav.folder.trash":
    case "nav.folder.starred":
    case "nav.folder.important":
      gotoFolder(cmd.slice("nav.folder.".length), state, dispatch);
      return;
    case "pane.open":
      if (state.focus === "threads") {
        dispatch({ type: "OPEN_THREAD" });
      } else if (state.focus === "message") {
        // Drill from the compact message list into the full single-message
        // view. Cursor (messageCursor) is preserved so the right pane shows
        // the message the user had highlighted.
        dispatch({ type: "SET_FOCUS", payload: "view" });
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
      // Tab cycles through every focusable pane in drill order.
      dispatch({
        type: "SET_FOCUS",
        payload:
          state.focus === "sidebar"
            ? "threads"
            : state.focus === "threads"
              ? state.thread
                ? "message"
                : "sidebar"
              : state.focus === "message"
                ? "view"
                : "sidebar",
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
    case "ui.cancel":
      // Drop any half-typed buffered key, clear transient status. Esc in the
      // empty-buffer case is a no-op (intentional — vim convention).
      if (state.keyBuffer) dispatch({ type: "CLEAR_KEY_BUFFER" });
      dispatch({ type: "SET_ERROR", payload: null });
      dispatch({ type: "SET_STATUS", payload: "" });
      return;
    case "ui.preview-toggle":
      // `z` flicks between the compact message list and the full single-
      // message view (the right-most drill panes). From the thread list,
      // a fresh thread is opened so `z` is a one-key "jump to read".
      if (state.focus === "view") {
        dispatch({ type: "SET_FOCUS", payload: "message" });
      } else if (state.focus === "message") {
        dispatch({ type: "SET_FOCUS", payload: "view" });
      } else if (state.focus === "threads" && !state.thread) {
        dispatch({ type: "OPEN_THREAD" });
      }
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
    case "msg.archive":
      if (!ensureSingleScope(state, dispatch)) return;
      archiveCurrent(state, dispatch);
      return;
    case "msg.archive-thread":
      if (!ensureSingleScope(state, dispatch)) return;
      archiveThread(state, dispatch);
      return;
    case "msg.spam":
      if (!ensureSingleScope(state, dispatch)) return;
      markSpam(state, dispatch);
      return;
    case "msg.forward":
      if (!ensureSingleScope(state, dispatch)) return;
      requestForward(state, dispatch);
      return;
    case "msg.label.add":
      if (!ensureSingleScope(state, dispatch)) return;
      dispatch({ type: "OPEN_OVERLAY", payload: { kind: "label", mode: "add", text: "" } });
      return;
    case "msg.label.remove":
      if (!ensureSingleScope(state, dispatch)) return;
      dispatch({ type: "OPEN_OVERLAY", payload: { kind: "label", mode: "remove", text: "" } });
      return;
    case "clip.thread-id":
      copyIdToClipboard("thread", state, dispatch);
      return;
    case "clip.message-id":
      copyIdToClipboard("message", state, dispatch);
      return;
    case "attach.download":
      if (!ensureSingleScope(state, dispatch)) return;
      downloadAttachments(state, dispatch);
      return;
    case "attach.preview":
      if (!ensureSingleScope(state, dispatch)) return;
      previewFirstImage(state, dispatch);
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

// `halfPageStep` / `pageStep` derive their magnitude from the terminal
// height, falling back to fixed sizes when the rows are unknown. List panes
// take up roughly the full screen height, so `rows - 4` (status bar + help
// bar + border) is a good page estimate. The actual cursor delta gets
// clamped against the list bounds inside the reducer.
function halfPageStep(): number {
  const rows = process.stdout.rows || 24;
  return Math.max(1, Math.floor((rows - 4) / 2));
}
function pageStep(): number {
  const rows = process.stdout.rows || 24;
  return Math.max(1, rows - 4);
}

function gotoFolder(
  folder: string,
  state: import("./reducer.js").AppState,
  dispatch: (a: Action) => void,
) {
  // Gmail system label ids — pinned constants so we don't depend on the
  // labels manifest being already loaded when the binding fires.
  const labelId =
    folder === "inbox"
      ? "INBOX"
      : folder === "sent"
        ? "SENT"
        : folder === "drafts"
          ? "DRAFT"
          : folder === "trash"
            ? "TRASH"
            : folder === "starred"
              ? "STARRED"
              : folder === "important"
                ? "IMPORTANT"
                : null;
  if (!labelId) {
    dispatch({ type: "SET_STATUS", payload: `Unknown folder: ${folder}` });
    return;
  }
  dispatch({ type: "SELECT_LABEL", payload: labelId });
  dispatch({ type: "SET_FOCUS", payload: "threads" });
  triggerLabelLoad(labelId, state.scope, dispatch);
}

function archiveCurrent(state: import("./reducer.js").AppState, dispatch: (a: Action) => void) {
  const msg = currentMessage(state);
  if (!msg) {
    dispatch({ type: "SET_STATUS", payload: "No message selected." });
    return;
  }
  (async () => {
    try {
      await gmail.modifyEmail({ messageId: msg.messageId, removeLabelIds: ["INBOX"] });
      dispatch({ type: "SET_STATUS", payload: "Archived." });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function archiveThread(state: import("./reducer.js").AppState, dispatch: (a: Action) => void) {
  // Prefer the currently-open thread id; falls back to the message-level
  // threadId when the open thread isn't loaded (rare).
  const threadId = state.thread?.threadId ?? currentMessage(state)?.threadId ?? null;
  if (!threadId) {
    dispatch({ type: "SET_STATUS", payload: "No thread selected." });
    return;
  }
  (async () => {
    try {
      await gmail.modifyThread({ threadId, removeLabelIds: ["INBOX"] });
      dispatch({ type: "SET_STATUS", payload: "Thread archived." });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function markSpam(state: import("./reducer.js").AppState, dispatch: (a: Action) => void) {
  const msg = currentMessage(state);
  if (!msg) {
    dispatch({ type: "SET_STATUS", payload: "No message selected." });
    return;
  }
  (async () => {
    try {
      // Gmail's "move to spam" is `addLabelIds: SPAM` + remove INBOX.
      await gmail.modifyEmail({
        messageId: msg.messageId,
        addLabelIds: ["SPAM"],
        removeLabelIds: ["INBOX"],
      });
      dispatch({ type: "SET_STATUS", payload: "Marked as spam." });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function requestForward(state: import("./reducer.js").AppState, dispatch: (a: Action) => void) {
  const msg = currentMessage(state);
  if (!msg) {
    dispatch({ type: "SET_STATUS", payload: "Open a thread before forwarding." });
    return;
  }
  const quoted = quoteReplyBody(msg.from, msg.date, msg.body);
  const subject = msg.subject.startsWith("Fwd:") ? msg.subject : `Fwd: ${msg.subject}`;
  // Forward is structurally a fresh compose (no auto-recipient) but seeded
  // with the original subject + quoted body. User fills To: in the editor.
  const template = buildComposeTemplate({ subject, body: quoted });
  dispatch({
    type: "REQUEST_EDITOR",
    payload: { kind: "compose", initialContent: template },
  });
}

function runLabelMutation(
  labelName: string,
  mode: "add" | "remove",
  state: import("./reducer.js").AppState,
  dispatch: (a: Action) => void,
) {
  const msg = currentMessage(state);
  if (!msg) {
    dispatch({ type: "SET_STATUS", payload: "No message selected." });
    return;
  }
  (async () => {
    try {
      if (mode === "add") {
        // `get_or_create_label` returns the existing label or makes one.
        const label = await gmail.getOrCreateLabel(labelName);
        await gmail.modifyEmail({ messageId: msg.messageId, addLabelIds: [label.id] });
        dispatch({
          type: "SET_STATUS",
          payload: `Added label "${label.name}".`,
        });
      } else {
        // Resolve the existing label id by name; can't remove a label that
        // doesn't exist, so surface a status if it's not found.
        const target = state.labels?.user.find((l) => l.name === labelName);
        if (!target) {
          dispatch({ type: "SET_STATUS", payload: `Label not found: ${labelName}` });
          return;
        }
        await gmail.modifyEmail({ messageId: msg.messageId, removeLabelIds: [target.id] });
        dispatch({ type: "SET_STATUS", payload: `Removed label "${labelName}".` });
      }
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function copyIdToClipboard(
  kind: "thread" | "message",
  state: import("./reducer.js").AppState,
  dispatch: (a: Action) => void,
) {
  const msg = currentMessage(state);
  const id = kind === "thread" ? (state.thread?.threadId ?? msg?.threadId) : msg?.messageId;
  if (!id) {
    dispatch({ type: "SET_STATUS", payload: `No ${kind} selected.` });
    return;
  }
  (async () => {
    try {
      const { spawn } = await import("node:child_process");
      // darwin-only — gracefully degrade elsewhere with a status message
      // instead of throwing into the unhandled-rejection path.
      if (process.platform !== "darwin") {
        dispatch({
          type: "SET_STATUS",
          payload: `Clipboard not available on ${process.platform}; ${kind}Id: ${id}`,
        });
        return;
      }
      const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.write(id);
      child.stdin.end();
      child.on("exit", (code) => {
        if (code === 0) {
          dispatch({ type: "SET_STATUS", payload: `Copied ${kind}Id: ${id}` });
        } else {
          dispatch({ type: "SET_STATUS", payload: `pbcopy exited ${code}; ${kind}Id: ${id}` });
        }
      });
    } catch (err) {
      dispatch({
        type: "SET_STATUS",
        payload: `Clipboard error (${kind}Id: ${id}): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  })();
}

// Download EVERY attachment on the currently-selected message into a
// per-message subdirectory of ~/Downloads. Filename collisions across
// messages stay isolated; collisions WITHIN a single message keep the
// original name (Gmail rarely sends two attachments with the same name).
function downloadAttachments(
  state: import("./reducer.js").AppState,
  dispatch: (a: Action) => void,
) {
  const msg = currentMessage(state);
  if (!msg) {
    dispatch({ type: "SET_STATUS", payload: "No message selected." });
    return;
  }
  if (msg.attachments.length === 0) {
    dispatch({ type: "SET_STATUS", payload: "No attachments on this message." });
    return;
  }
  // Collect ids first — `get_thread` exposes them on each attachment
  // (the schema fix earlier in this branch added the optional `id` field).
  // Attachments without an id are skipped with a status warning.
  const idable = msg.attachments.filter((a): a is { id: string } & typeof a => "id" in a && !!a.id);
  if (idable.length === 0) {
    dispatch({
      type: "SET_STATUS",
      payload: "Attachments are listed but Gmail returned no attachmentIds — re-open the thread.",
    });
    return;
  }
  (async () => {
    try {
      const os = await import("node:os");
      const path = await import("node:path");
      const savePath = path.join(os.homedir(), "Downloads", `gmail-${msg.messageId}`);
      const results = await Promise.all(
        idable.map((a) =>
          gmail.downloadAttachment({
            messageId: msg.messageId,
            attachmentId: a.id,
            filename: a.filename,
            savePath,
          }),
        ),
      );
      dispatch({
        type: "SET_STATUS",
        payload: `Downloaded ${results.length} file(s) to ${savePath}`,
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

// Open the first image attachment with the system viewer. macOS `open` is
// used today — gracefully degrades elsewhere with a status message that
// names the downloaded file path so the user can open it manually. Inline
// terminal-protocol image rendering (kitty/iTerm2/Ghostty) is a future
// upgrade — requires Ink stdout suspension, similar to the editor hook.
function previewFirstImage(state: import("./reducer.js").AppState, dispatch: (a: Action) => void) {
  const msg = currentMessage(state);
  if (!msg) {
    dispatch({ type: "SET_STATUS", payload: "No message selected." });
    return;
  }
  const image = msg.attachments.find((a) => a.mimeType.startsWith("image/") && "id" in a && a.id) as
    | ({ id: string } & (typeof msg.attachments)[number])
    | undefined;
  if (!image) {
    dispatch({ type: "SET_STATUS", payload: "No image attachment on this message." });
    return;
  }
  (async () => {
    try {
      const os = await import("node:os");
      const path = await import("node:path");
      const savePath = path.join(os.homedir(), "Downloads", `gmail-${msg.messageId}`);
      const result = await gmail.downloadAttachment({
        messageId: msg.messageId,
        attachmentId: image.id,
        filename: image.filename,
        savePath,
      });
      if (process.platform === "darwin") {
        const { spawn } = await import("node:child_process");
        spawn("open", [result.path], { detached: true, stdio: "ignore" }).unref();
        dispatch({ type: "SET_STATUS", payload: `Opening ${result.path}` });
      } else {
        dispatch({
          type: "SET_STATUS",
          payload: `Saved ${result.path} — open with your image viewer (${process.platform} preview not wired)`,
        });
      }
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
