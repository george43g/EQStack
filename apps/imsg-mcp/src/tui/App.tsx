import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allocateWidths, splitNavChunk, useMouse } from "@george43g/tui-kit";
import { useScreenSize } from "fullscreen-ink";
import { Box, type Key as KeyState, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from "react";
import { loadTuiConfig, resolveInterpretConfig, writeTuiConfig } from "../app-config.js";
import { formatJumpTarget, parseUserDate } from "../date-parse.js";
import type { ChangeEvent, EventBus } from "../event-bus.js";
import { extensionFor, toCSV, toJSON, toMarkdown } from "../export-formats.js";
import {
  applyInlineInterpretations,
  getInterpretRuntime,
  primaryMediaRef,
} from "../media-intel-runtime.js";
import { noteShutdownCause, registerCleanup } from "../shutdown.js";
import { type Conversation, type Message, oldestMessageCursor, type Reaction } from "../types.js";
import { getInstalledChatApps } from "../url-schemes.js";
import {
  nudgeAttachmentDownload,
  openAttachmentFile,
  openAttachmentWithNudge,
  revealAttachment,
  revealAttachmentFile,
  saveAllAttachmentFiles,
  saveAttachmentFile,
  saveAttachmentWithNudge,
} from "./attachmentActions.js";
import { createChangeStream, emptyChangeSnapshot, noopSubscribe } from "./change-stream.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ComposeRecipientModal } from "./components/ComposeRecipientModal.js";
import { DateJumpModal } from "./components/DateJumpModal.js";
import { CompactStats, DevStats } from "./components/DevStats.js";
import { ExportModal } from "./components/ExportModal.js";
import { HelpBar } from "./components/HelpBar.js";
import { InfoDrawer } from "./components/InfoDrawer.js";
import { MessageDrawer } from "./components/MessageDrawer.js";
import { SendViaModal } from "./components/SendViaModal.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { StatusBar } from "./components/StatusBar.js";
import { nextGroupBoundary, prevGroupBoundary, ThreadPane } from "./components/ThreadPane.js";
import { filterMatchIndices } from "./filter.js";
import { useDevStats } from "./hooks/useDevStats.js";
import { useImsg } from "./hooks/useImsg.js";
import { appendCached } from "./messageCache.js";
import { allCommands, findModule } from "./modules/registry.js";
import {
  applySettingsKey,
  buildSettingsRows,
  firstSelectableIndex,
  lastSelectableIndex,
  openSettings,
  type SettingsKeyAction,
  stepSelectable,
} from "./settings-model.js";
import { type ConversationTouch, initialState, reducer, sidebarRowCount } from "./types.js";

/** Fold one live message into a per-thread sidebar touch (latest wins for
 *  snippet/date; unread deltas accumulate across a batch). */
function mergeTouch(
  prev: ConversationTouch | undefined,
  threadSlug: string,
  m: Message,
  unreadDelta: number,
): ConversationTouch {
  return {
    threadSlug,
    snippet: m.text ?? prev?.snippet ?? null,
    lastMessageDate: m.date,
    unreadDelta: (prev?.unreadDelta ?? 0) + unreadDelta,
  };
}

export interface AppProps {
  /**
   * Live change stream (ChangeWatcher → EventBus). runTui constructs the
   * bus; App arms a ChangeWatcher over its own DB connection onto it. Tests
   * inject a fake bus and emit on it directly. Omitted → the TUI stays
   * refresh-only (manual `r`).
   */
  changeBus?: EventBus;
}

export function App({ changeBus }: AppProps = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { exit } = useApp();
  // Guard the screen size at the source: under ink-testing-library (no TTY)
  // useScreenSize yields non-finite rows, and every downstream computation
  // (bodyHeight → pane heights → line budgets) inherits the NaN. The old
  // hand-rolled window walk happened to fail CLOSED under NaN (comparisons
  // all false → 1-item window); tui-kit lineWindow 0.5.0 fails OPEN (its
  // break condition is false too → the ENTIRE thread renders — measured
  // 65MB of retained fiber in tui-memory.test). Finite fallbacks make the
  // failure mode impossible rather than merely accidental.
  const { width: rawColumns, height: rawRows } = useScreenSize();
  const columns = Number.isFinite(rawColumns) ? rawColumns : 80;
  const rows = Number.isFinite(rawRows) ? rawRows : 24;
  const imsg = useImsg();
  // `visible` gates the SAMPLING RATE, not whether stats exist: panel open =
  // live 2s ticks; panel closed = the footer rides the watchdog's 60s memory
  // sample (a 2s always-on setState re-rendered the whole app 30×/min and
  // drove ~20MB/min heap growth — two real rss_exceeded kills on 2026-07-12).
  const { stats: devStats, recordQueryTime } = useDevStats(state.showDevStats);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ggPendingRef = useRef(false); // tracks if 'g' was pressed, waiting for second 'g'
  const ggTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Column widths via tui-kit `allocateWidths` (0.5.0). Per the kit contract,
  // fractions and mode-gating are the CALLER's business: the drawer's 35%/40%
  // (capped 50/60) is computed here, and a closed column is OMITTED from the
  // spec rather than passed as width 0. All columns pin at their floor
  // (`collapse: "min"`) — on a terminal narrower than the floor sum the
  // renderer clips, exactly as the old hand-rolled formulae behaved. The
  // thread column has no `max`, so the remainder lands on it (highest
  // priority not at ceiling), matching the old `columns - …` remainder line.
  const detailPaneWidth =
    state.mode === "drawer"
      ? Math.min(Math.floor(columns * 0.35), 50)
      : state.mode === "info"
        ? Math.min(Math.floor(columns * 0.4), 60)
        : 0;
  const alloc = allocateWidths(columns, [
    { id: "thread", min: 20, preferred: 20, priority: 3, collapse: "min" },
    {
      id: "sidebar",
      min: 28,
      preferred: Math.max(
        Math.floor((columns - detailPaneWidth - (state.showDevStats ? 20 : 0)) * 0.32),
        28,
      ),
      priority: 2,
      collapse: "min",
    },
    ...(detailPaneWidth > 0
      ? [
          {
            id: "detail",
            min: detailPaneWidth,
            preferred: detailPaneWidth,
            max: detailPaneWidth,
            priority: 1,
            collapse: "min" as const,
          },
        ]
      : []),
    ...(state.showDevStats
      ? [
          {
            id: "devstats",
            min: 20,
            preferred: 20,
            max: 20,
            priority: 0,
            collapse: "min" as const,
          },
        ]
      : []),
  ]);
  const drawerWidth = alloc.widths.detail ?? 0;
  const devStatsWidth = alloc.widths.devstats ?? 0;
  const sidebarWidth = alloc.widths.sidebar ?? 28;
  const threadWidth = alloc.widths.thread ?? 20;
  const bodyHeight = rows - 2; // status + help

  // Sidebar item layout: each item = 4 rows (name + snippet + slug + separator)
  // Header row + filter row + borders subtract from available height.
  // Mirror the calculation in Sidebar.tsx so SELECT dispatches include the
  // right visible-count and the cursor stays on screen as the user navigates.
  const SIDEBAR_ITEM_HEIGHT = 4;
  const sidebarVisibleCount = Math.max(
    Math.floor((bodyHeight - 1 - (state.filterQuery ? 1 : 0) - 2) / SIDEBAR_ITEM_HEIGHT),
    1,
  );

  const selected =
    state.selectedModuleIdx == null ? state.conversations[state.selectedIdx] : undefined;
  const selectedModule =
    state.selectedModuleIdx != null ? state.moduleInstances[state.selectedModuleIdx] : undefined;
  const totalUnread = state.conversations.reduce((s, c) => s + c.unreadCount, 0);
  const resolvedNames = selected ? imsg.resolveNames(selected.participants) : [];
  const selectedMsg = state.selectedMsgIdx >= 0 ? state.messages[state.selectedMsgIdx] : undefined;

  // handle → contact name for the message drawer's reaction rows, which
  // otherwise print a raw `+61…` where a person's name belongs. Memoized on the
  // selected message so opening the drawer costs one batched lookup rather than
  // one per reaction per render (name resolution goes to the contacts DB).
  const reactionNames = useMemo(() => {
    const handles = [
      ...new Set((selectedMsg?.reactions ?? []).map((r) => r.fromHandle).filter(Boolean)),
    ] as string[];
    if (handles.length === 0) return {};
    const names = imsg.resolveNames(handles);
    return Object.fromEntries(handles.map((h, i) => [h, names[i] ?? h]));
  }, [selectedMsg, imsg]);

  // Commands list for the palette — recomputed on state change so `when`
  // gates and module command lists stay in sync.
  const commands = useMemo(() => allCommands(state), [state]);
  const commandCtx = useMemo(() => ({ state, dispatch, imsg }), [state, imsg]);

  // ── Data loading ───────────────────────────────────────────────────

  const loadMessages = useCallback(
    async (idx: number, convOverride?: Conversation) => {
      // convOverride exists because this callback closes over the render's
      // state.conversations — on mount (and right after a refresh dispatch)
      // that closure is STALE (empty on first load), so indexing into it
      // silently no-ops and the initially selected thread shows
      // "No messages" until the user navigates away and back.
      const conv = convOverride ?? state.conversations[idx];
      if (!conv) return;
      dispatch({
        type: "SET_LOADING",
        loading: true,
        status: `Loading ${conv.displayName ?? conv.chatIdentifier}...`,
      });
      const t0 = performance.now();
      const msgs = await imsg.loadMessages(conv.chatIdentifier);
      recordQueryTime(performance.now() - t0);
      dispatch({ type: "SET_MESSAGES", data: msgs });
      dispatch({ type: "SET_LOADING", loading: false, status: "" });
    },
    [state.conversations, imsg, recordQueryTime],
  );

  // Interpret (or re-interpret with force) the selected message's media on
  // demand — the `R` key. Frontends stay render-only: the actual work is in
  // core (getInterpretRuntime().service). Status feedback flows through the bar;
  // the resolved transcript lands on the message via SET_MESSAGE_INTERPRET.
  const interpretMessage = useCallback(async (msg: Message | undefined, force = false) => {
    if (!msg) return;
    const ref = primaryMediaRef(msg);
    if (!ref) {
      dispatch({ type: "SET_STATUS", status: "No voice note / media on this message." });
      return;
    }
    dispatch({ type: "SET_STATUS", status: force ? "Re-interpreting…" : "Transcribing…" });
    // Let the ⏳ status paint before the (possibly blocking) local transcription.
    await new Promise((r) => setTimeout(r, 0));
    try {
      const result = await getInterpretRuntime().service.interpret(ref, { force });
      if (result.status === "done" && result.text) {
        dispatch({
          type: "SET_MESSAGE_INTERPRET",
          msgId: msg.id,
          interpretedMedia: { kind: ref.kind, text: result.text, source: result.source ?? "?" },
        });
        dispatch({ type: "SET_STATUS", status: `Interpreted (${result.source ?? "?"}).` });
      } else if (result.status === "skipped") {
        dispatch({
          type: "SET_STATUS",
          status: "Interpretation is off — enable it with `imsg setup --interactive`.",
        });
      } else {
        dispatch({
          type: "SET_STATUS",
          status: `No transcript${result.error ? `: ${result.error}` : "."}`,
        });
      }
    } catch (e) {
      dispatch({
        type: "SET_STATUS",
        status: `Interpretation failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, []);

  // ── Settings panel ─────────────────────────────────────────────────
  // Flattened, navigable rows for the current interpret block. Recomputed as
  // the user edits so cursor math + rendering stay in sync.
  const settingsRows = useMemo(
    () =>
      state.settingsInterpret
        ? buildSettingsRows(state.settingsInterpret, state.settingsKeyPresence)
        : [],
    [state.settingsInterpret, state.settingsKeyPresence],
  );

  // Apply one key action to the selected settings row, persist to disk, and
  // move the cursor to follow a reordered chain item. Writes stay in the
  // frontend (side effect); the mutation itself is pure (settings-model).
  const applySettings = useCallback(
    (action: SettingsKeyAction) => {
      const cur = state.settingsInterpret;
      if (!cur) return;
      const row = settingsRows[state.settingsCursor];
      const next = applySettingsKey(cur, row, action);
      if (!next) return;
      try {
        const loaded = loadTuiConfig();
        writeTuiConfig({ ...loaded.config, interpret: next }, state.settingsConfigPath);
        dispatch({ type: "SET_SETTINGS_INTERPRET", interpret: next });
        // A reorder moves the item; keep the cursor on it so repeated K/J walk it.
        if (action === "moveUp") {
          dispatch({ type: "SET_SETTINGS_CURSOR", index: Math.max(0, state.settingsCursor - 1) });
        } else if (action === "moveDown") {
          dispatch({ type: "SET_SETTINGS_CURSOR", index: state.settingsCursor + 1 });
        }
        dispatch({ type: "SET_STATUS", status: "Settings saved." });
        setTimeout(() => dispatch({ type: "SET_STATUS", status: "" }), 2000);
      } catch (e) {
        dispatch({
          type: "SET_STATUS",
          status: `Settings write failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [state.settingsInterpret, state.settingsCursor, state.settingsConfigPath, settingsRows],
  );

  const refreshAll = useCallback(async () => {
    dispatch({ type: "SET_LOADING", loading: true, status: "Refreshing..." });
    const convs = await imsg.loadConversations();
    dispatch({ type: "SET_CONVERSATIONS", data: convs });
    if (convs.length > 0) {
      const prevSlug = selected?.threadSlug;
      let targetIdx = Math.min(Math.max(state.selectedIdx, 0), convs.length - 1);
      if (prevSlug) {
        const idx = convs.findIndex((c) => c.threadSlug === prevSlug);
        if (idx >= 0) {
          dispatch({ type: "SELECT", index: idx, visibleCount: sidebarVisibleCount });
          targetIdx = idx;
        }
      }
      // Pass the fresh conversation object — the loadMessages closure's
      // state.conversations is stale here (empty on mount, pre-refresh
      // otherwise), which left the initial thread stuck on "No messages".
      await loadMessages(targetIdx, convs[targetIdx]);
    }
    imsg.refresh();
    dispatch({ type: "SET_LOADING", loading: false, status: "" });
  }, [imsg, loadMessages, selected?.threadSlug, state.selectedIdx, sidebarVisibleCount]);

  // Reload ONLY the conversation list (e.g. right after sending) so the
  // messaged thread reappears / bumps to the top and stays selectable — without
  // refreshAll's full-reload flash or its redundant message re-fetch (the send
  // path already set the messages). Re-selects the current thread by slug so the
  // cursor follows it to its new position instead of landing on a stale row.
  const refreshConversations = useCallback(async () => {
    const slug = selected?.threadSlug;
    const convs = await imsg.loadConversations();
    dispatch({ type: "SET_CONVERSATIONS", data: convs });
    if (slug) {
      const idx = convs.findIndex((c) => c.threadSlug === slug);
      if (idx >= 0) dispatch({ type: "SELECT", index: idx, visibleCount: sidebarVisibleCount });
    }
  }, [imsg, selected?.threadSlug, sidebarVisibleCount]);

  // ── Live change stream (ChangeWatcher → EventBus → useSyncExternalStore) ──

  const changeStream = useMemo(
    () => (changeBus ? createChangeStream(changeBus) : null),
    [changeBus],
  );
  // Hooks can't be conditional — without a bus, subscribe/getSnapshot are the
  // stable no-op pair from the adapter module.
  const changeSnapshot = useSyncExternalStore(
    changeStream ? changeStream.subscribe : noopSubscribe,
    changeStream ? changeStream.getSnapshot : emptyChangeSnapshot,
  );
  const lastLiveVersionRef = useRef(0);

  /**
   * Route one accumulated event batch:
   *  - Events on the ACTIVE thread append to the message list (or fold as
   *    reactions). Membership check = per-identity thread slug (every merged
   *    leg shares it — see useImsg.getThreadSlugForLeg), never a new merge.
   *  - Other known threads get an in-place sidebar patch (snippet / date /
   *    unread) — no reorder, no per-event DB round trip.
   *  - An event for a thread not in the sidebar (brand-new conversation, or
   *    a leg the slug store can't map yet) falls back to one
   *    refreshConversations() so the row appears.
   */
  const handleLiveEvents = useCallback(
    (events: readonly ChangeEvent[]) => {
      const activeSlug = selected?.threadSlug ?? null;
      const appendable: Message[] = [];
      const reactions: Reaction[] = [];
      const touches = new Map<string, ConversationTouch>();
      let unknownConversation = false;
      const knownSlugs = new Set(state.conversations.map((c) => c.threadSlug));

      for (const e of events) {
        if (!("message" in e)) continue; // group.* variants — no consumer yet
        const m = e.message;
        const slug = m.chatId ? imsg.getThreadSlugForLeg(m.chatId) : null;
        if (activeSlug && slug === activeSlug) {
          if (e.type === "reaction") {
            if (m.reaction) reactions.push(m.reaction);
          } else {
            appendable.push(m);
            // Keep the active row's snippet/date current too — but never bump
            // its unread count while the user is looking at it.
            touches.set(activeSlug, mergeTouch(touches.get(activeSlug), activeSlug, m, 0));
          }
          continue;
        }
        if (e.type !== "message.new") continue; // sidebar ignores foreign reactions
        if (!slug || !knownSlugs.has(slug)) {
          unknownConversation = true;
          continue;
        }
        touches.set(slug, mergeTouch(touches.get(slug), slug, m, m.isFromMe ? 0 : 1));
      }

      if (appendable.length > 0) {
        // Same inline-interpretation peek as the initial load (cached /
        // instant results only — never a blocking cloud call).
        applyInlineInterpretations(appendable);
        if (selected) appendCached(selected.chatIdentifier, appendable);
        dispatch({ type: "APPEND_LIVE_MESSAGES", data: appendable });
      }
      if (reactions.length > 0) dispatch({ type: "APPLY_LIVE_REACTIONS", reactions });
      if (touches.size > 0) {
        dispatch({ type: "TOUCH_CONVERSATIONS", touches: [...touches.values()] });
      }
      if (unknownConversation) void refreshConversations();
    },
    [selected, state.conversations, imsg, refreshConversations],
  );

  // Process each new snapshot version exactly once. On adapter overflow the
  // delta is incomplete — fall back to the manual-refresh path instead.
  useEffect(() => {
    if (!changeStream) return;
    if (changeSnapshot.version <= lastLiveVersionRef.current) return;
    lastLiveVersionRef.current = changeSnapshot.version;
    if (changeSnapshot.overflowed) {
      changeStream.ack(changeSnapshot.version);
      void refreshAll();
      return;
    }
    handleLiveEvents(changeSnapshot.batch);
    changeStream.ack(changeSnapshot.version);
  }, [changeStream, changeSnapshot, handleLiveEvents, refreshAll]);

  // Arm the ChangeWatcher over this App's DB connection. registerCleanup
  // covers process exit; the effect teardown covers unmount (tests).
  // biome-ignore lint/correctness/useExhaustiveDependencies: arm once on mount
  useEffect(() => {
    if (!changeBus) return;
    const watcher = imsg.startChangeWatcher(changeBus);
    if (!watcher) return;
    registerCleanup(() => watcher.stop());
    return () => watcher.stop();
  }, []);

  // ── Lazy-load more conversations when user nears the end ──────────────
  const NEAR_END_THRESHOLD = 20;
  const CONV_BATCH_SIZE = 100;

  const loadMoreConversations = useCallback(async () => {
    if (state.conversationLoadingMore) return;
    const targetCount = state.conversationLoadedCount + CONV_BATCH_SIZE;
    dispatch({ type: "SET_STATUS", status: `Loading more conversations (${targetCount})...` });
    const convs = await imsg.loadConversations(targetCount);
    dispatch({ type: "APPEND_CONVERSATIONS", data: convs, loadedCount: targetCount });
    dispatch({ type: "SET_STATUS", status: "" });
  }, [imsg, state.conversationLoadingMore, state.conversationLoadedCount]);

  // ── Lazy-load older messages when cursor nears the top ────────────────
  const NEAR_TOP_THRESHOLD = 10;
  const _MSG_BATCH_SIZE = 100;

  // Cooldown between older-page loads. Sequentiality alone doesn't bound the
  // page RATE: a held wheel at the top re-fires the near-top effect the
  // moment each page lands, and on big real-DB threads each page carries a
  // heavy transient allocation cost (extended-data blobs for up to 2×limit
  // rows per merged leg) — sustained, that inflated RSS to the watchdog's
  // kill threshold inside 3 minutes. 300ms still walks >3 pages/second.
  const OLDER_LOAD_COOLDOWN_MS = 300;
  const lastOlderLoadAtRef = useRef(0);

  const loadOlderMessages = useCallback(async () => {
    if (!selected) return;
    if (state.messageLoadingOlder) return;
    if (state.messageOldestLoadedId == null) return;
    dispatch({ type: "SET_LOADING_OLDER", loading: true });
    lastOlderLoadAtRef.current = Date.now();
    const olderMsgs = await imsg.loadOlderMessages(
      selected.chatIdentifier,
      state.messageOldestLoadedId,
    );
    // Progress is measured by whether the batch contains any message we don't
    // already have — NOT by comparing ROWIDs (which diverge from date order in
    // merged threads and falsely declared exhaustion mid-thread, stranding
    // tens of thousands of messages). The cursor advances to the oldest
    // message by (date, ROWID) among the truly-new rows.
    const loadedIds = new Set(state.messages.map((m) => m.id));
    const trulyNew = olderMsgs.filter((m) => !loadedIds.has(m.id));
    if (trulyNew.length === 0) {
      dispatch({ type: "PREPEND_MESSAGES", data: [], oldestId: -1 });
      return;
    }
    const newOldestId = oldestMessageCursor(trulyNew) ?? -1;
    dispatch({ type: "PREPEND_MESSAGES", data: trulyNew, oldestId: newOldestId });
  }, [imsg, selected, state.messageLoadingOlder, state.messageOldestLoadedId, state.messages]);

  // Trigger when cursor approaches the start of the message list
  useEffect(() => {
    if (state.loading || state.messageLoadingOlder) return;
    if (state.messages.length === 0) return;
    if (state.messageOldestLoadedId === -1) return; // exhausted
    if (Date.now() - lastOlderLoadAtRef.current < OLDER_LOAD_COOLDOWN_MS) return;
    if (state.selectedMsgIdx >= 0 && state.selectedMsgIdx < NEAR_TOP_THRESHOLD) {
      loadOlderMessages();
    }
  }, [
    state.selectedMsgIdx,
    state.messages.length,
    state.messageOldestLoadedId,
    state.messageLoadingOlder,
    state.loading,
    loadOlderMessages,
  ]);

  // Trigger lazy-load when cursor or scroll is near the end of loaded items.
  // Important: only fire when we've actually grown — DB returns N when N requested,
  // so once `conversations.length === conversationLoadedCount` and we asked for
  // 200, asking for 300 may yield no new entries (chat history exhausted).
  useEffect(() => {
    if (state.loading || state.conversationLoadingMore) return;
    if (state.conversations.length === 0) return;
    const cursorNearEnd = state.selectedIdx >= state.conversations.length - NEAR_END_THRESHOLD;
    const scrollNearEnd =
      state.sidebarScroll + sidebarVisibleCount >= state.conversations.length - NEAR_END_THRESHOLD;
    if (cursorNearEnd || scrollNearEnd) {
      // Only ask for more if we haven't seen this chat-count plateau yet
      if (state.conversationLoadedCount === state.conversations.length) {
        loadMoreConversations();
      }
    }
  }, [
    state.selectedIdx,
    state.sidebarScroll,
    state.conversations.length,
    state.conversationLoadedCount,
    state.conversationLoadingMore,
    state.loading,
    sidebarVisibleCount,
    loadMoreConversations,
  ]);

  // Initial load + register cleanup.
  //
  // The load is deferred by one macrotask ON PURPOSE — do not inline it back.
  // `better-sqlite3` is SYNCHRONOUS: `await imsg.loadConversations()` never
  // yields, so opening the DB (~95ms) plus `listConversations` (~1.8s on a
  // 5.5k-chat account) blocks the event loop solid. Running that straight from
  // the mount effect starves Ink's first flush, so the user sits in front of a
  // freshly-cleared alt-screen with NOTHING on it — measured at ~2.2s blank,
  // ~4.6s to first paint. Yielding first lets Ink write frame one (which
  // already says "Loading conversations…" via initialState) before we block.
  // biome-ignore lint/correctness/useExhaustiveDependencies: we intentionally run this only on mount to prevent a render-loop
  useEffect(() => {
    registerCleanup(() => imsg.close());
    const t = setTimeout(() => void refreshAll(), 0);
    return () => clearTimeout(t);
  }, [imsg.close]);

  // ── Send logic ─────────────────────────────────────────────────────

  const sendMessage = useCallback(async () => {
    if (!selected || !state.composeText.trim()) return;
    const text = state.composeText.trim();
    dispatch({ type: "ADD_PENDING", msg: { text, sentAt: new Date(), status: "sending" } });

    // Wrap the entire send + poll setup so any thrown error surfaces as a
    // FAIL_PENDING in the UI rather than escaping as an unhandled rejection.
    // Pre-fix, an osascript / DB exception here would log silently and the
    // pending bubble would just sit in "sending" forever, which read as
    // "the tool exited" when combined with a phantom watchdog kill.
    try {
      const result = await imsg.send(selected.threadSlug, text);
      if (!result.success) {
        dispatch({ type: "FAIL_PENDING", text });
        return;
      }

      let attempt = 0;
      const poll = async () => {
        // Check if we are still polling for this request (unmounted or cancelled)
        if (!pollTimerRef.current) return;
        attempt++;
        try {
          const msgs = await imsg.loadMessages(selected.chatIdentifier);
          const found = msgs.some((m) => m.isFromMe && m.text?.includes(text));
          const failed = msgs.some(
            (m) => m.isFromMe && m.sendError !== undefined && m.text?.includes(text),
          );
          if (failed) {
            // The row landed but with a send error (e.g. wrong-service
            // attempt) — surface the failure instead of a green bubble.
            dispatch({ type: "SET_MESSAGES", data: msgs });
            dispatch({ type: "FAIL_PENDING", text });
          } else if (found) {
            dispatch({ type: "SET_MESSAGES", data: msgs });
            dispatch({ type: "RESOLVE_PENDING", text });
            // Bump/insert the messaged thread in the sidebar so its row moves to
            // the top and is immediately selectable — previously it stayed stale
            // (or absent, for a brand-new thread) until a manual `r` refresh.
            void refreshConversations();
          } else if (attempt < 7) {
            pollTimerRef.current = setTimeout(poll, 1500);
          } else {
            // Poll exhausted without ever seeing our message — don't leave
            // the bubble spinning in "sending" forever.
            dispatch({ type: "FAIL_PENDING", text });
          }
        } catch {
          // Poll iteration failed (DB locked, transient I/O); drop the
          // pending state rather than spin forever or leak the rejection.
          dispatch({ type: "FAIL_PENDING", text });
        }
      };
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = setTimeout(poll, 1500);
    } catch {
      dispatch({ type: "FAIL_PENDING", text });
    }
  }, [selected, state.composeText, imsg, refreshConversations]);

  /**
   * Move the sidebar cursor to a combined index that spans
   * [modules..., conversations...]. Dispatches to the right reducer action
   * based on which region the target lands in, and only fires `loadMessages`
   * when a real conversation is selected.
   */
  const selectSidebarCombined = useCallback(
    (combinedIdx: number) => {
      const moduleCount = state.moduleInstances.length;
      if (combinedIdx < moduleCount) {
        dispatch({
          type: "SELECT_MODULE",
          index: combinedIdx,
          visibleCount: sidebarVisibleCount,
        });
        return;
      }
      const convIdx = combinedIdx - moduleCount;
      dispatch({ type: "SELECT", index: convIdx, visibleCount: sidebarVisibleCount });
      // Debounce message loading (matches existing behaviour).
      if (moveDebounceRef.current) clearTimeout(moveDebounceRef.current);
      const target = convIdx;
      moveDebounceRef.current = setTimeout(() => {
        moveDebounceRef.current = null;
        loadMessages(target);
      }, 80);
    },
    [state.moduleInstances.length, sidebarVisibleCount, loadMessages],
  );

  // ── Vim number prefix helper ───────────────────────────────────────

  const getCount = useCallback((): number => {
    const n = state.numBuffer ? Number.parseInt(state.numBuffer, 10) : 1;
    dispatch({ type: "SET_NUM_BUFFER", value: "" });
    return Math.max(1, Math.min(n, 999));
  }, [state.numBuffer]);

  // ── Keyboard ───────────────────────────────────────────────────────

  // Keys whose handlers compare `input` to a SINGLE character. Ink delivers a
  // fast keystroke burst (or a paste) as ONE call with the whole string, so
  // "jj" never equalled "j" and rapid scrolling silently dropped most of the
  // input. Worse, the vim count guard used a lexicographic range, which "5j"
  // satisfies — a chunked count entered the buffer whole and replayed on the
  // NEXT key (a lone `j` jumping 5 rows for no visible reason).
  //
  // The pure half of this chunked-keystroke law now lives upstream as tui-kit
  // `splitNavChunk` (0.5.0, lifted from this router): ALL-OR-NOTHING — a chunk
  // containing anything outside the owned set returns null and is passed
  // through whole, so a pasted recipient name or an escape sequence can never
  // drive motion or reach a destructive key. The stateful half (which modes
  // are active, what each key means) stays HERE, per the input-guard law.
  const OWNED_NAV_KEYS = new Set([..."0123456789gGjk{}"]);

  const handleKeyRef = useRef<((input: string, key: KeyState) => Promise<void>) | null>(null);

  useInput(async (input, key) => {
    // Fan out a multi-key chunk into single-key dispatches, in order.
    if (input.length > 1 && !key.ctrl && !key.meta && !key.escape && handleKeyRef.current) {
      const split = splitNavChunk(input, OWNED_NAV_KEYS);
      if (split) {
        for (const ch of split) await handleKeyRef.current(ch, key);
        return;
      }
    }
    await handleKeyRef.current?.(input, key);
  });

  const handleKey = async (input: string, key: KeyState) => {
    // Ctrl-C always exits
    if (key.ctrl && input === "c") {
      noteShutdownCause("user_quit");
      await imsg.close();
      exit();
      return;
    }

    // Palette mode — owns its own useInput (inside CommandPalette).
    // Skip all App-level handling so navigation keys don't double-fire.
    if (state.mode === "palette") {
      return;
    }

    // Ctrl-P opens the palette from anywhere outside an active modal.
    if (key.ctrl && input === "p" && (state.mode === "browse" || state.mode === "select")) {
      dispatch({ type: "OPEN_PALETTE" });
      return;
    }

    // `?` from browse mode opens the palette as a keybinding cheat sheet.
    if (input === "?" && !key.ctrl && !key.meta && state.mode === "browse") {
      dispatch({ type: "OPEN_PALETTE" });
      return;
    }

    // Module pane mode — when a module instance is selected and thread pane is
    // focused, the pane's own useInput owns everything (Tab cycles type, [/]
    // cycles range, Esc closes). Tab MUST NOT be intercepted here: the pane
    // advertises "Tab:type" in its footer and the PR contract documents Tab as
    // the type-cycle key. Previously this branch dispatched FOCUS:sidebar on
    // Tab, which silently overrode the pane's handler.
    if (selectedModule && state.focus === "thread" && state.mode === "browse") {
      // Shift-Tab returns focus to the sidebar so the user can navigate to
      // another conversation without closing the module. Regular Tab and
      // every other key falls through to the pane's own useInput.
      if (key.shift && key.tab) {
        dispatch({ type: "FOCUS", pane: "sidebar" });
        return;
      }
      return;
    }

    // Filter mode. Type to narrow the list; ↑/↓ (or Ctrl-p/Ctrl-n) walk the
    // matches; Enter commits the HIGHLIGHTED match; Esc cancels. Printable keys
    // (incl. j/k) edit the query — navigation is on the arrows so you can still
    // type any contact name — while the filterCursor tracks the selected match.
    if (state.mode === "filter") {
      if (key.return) {
        // Commit the currently-highlighted match (filterCursor), not just the
        // first. The SELECT moves the cursor; loadMessages loads the thread —
        // without it the pane keeps showing the previously-loaded conversation
        // under the newly-selected header (every other selection path loads).
        const matches = filterMatchIndices(state.conversations, state.filterQuery);
        const matchIdx = matches[state.filterCursor];
        if (matchIdx !== undefined) {
          dispatch({ type: "SELECT", index: matchIdx, visibleCount: sidebarVisibleCount });
          void loadMessages(matchIdx, state.conversations[matchIdx]);
        }
        dispatch({ type: "EXIT_FILTER", restoreSelection: false });
      } else if (key.escape) {
        // Cancel: put the pre-filter selection back. Filtering snaps
        // selectedIdx to 0 on each keystroke, so plain exit would leave the
        // old thread's messages under conversation #0's name.
        dispatch({ type: "EXIT_FILTER", restoreSelection: true });
      } else if (key.downArrow || (key.ctrl && input === "n")) {
        dispatch({ type: "FILTER_MOVE", delta: 1, visibleCount: sidebarVisibleCount });
      } else if (key.upArrow || (key.ctrl && input === "p")) {
        dispatch({ type: "FILTER_MOVE", delta: -1, visibleCount: sidebarVisibleCount });
      } else if (key.backspace || key.delete) {
        dispatch({ type: "UPDATE_FILTER", query: state.filterQuery.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        dispatch({ type: "UPDATE_FILTER", query: state.filterQuery + input });
      }
      return;
    }

    // Compose mode
    if (state.mode === "compose") {
      if (key.escape) {
        dispatch({ type: "CANCEL_COMPOSE" });
      } else if (key.return && state.composeText.trim()) {
        dispatch({ type: "CONFIRM_SEND" });
      }
      return;
    }

    // Compose-to-new-thread modal: ComposeRecipientModal owns ALL input
    // (recipient typing, digit match-select, Enter to advance, Esc to cancel).
    // Ink fires every useInput handler, so without this early return the
    // browse-mode keys below still fire — most dangerously `q` (quit) when a
    // recipient name contains a "q", which silently killed the whole TUI.
    if (state.mode === "compose-new") {
      return;
    }

    // Confirm mode
    if (state.mode === "confirm") {
      if (key.return) {
        await sendMessage();
      } else {
        dispatch({ type: "CANCEL_COMPOSE" });
      }
      return;
    }

    // Drawer mode
    if (state.mode === "drawer") {
      const attCount = selectedMsg?.attachments?.length ?? 0;
      if (key.escape || input === "q") {
        dispatch({ type: "CLOSE_DRAWER" });
      } else if ((input === "j" || key.downArrow) && attCount > 1) {
        dispatch({
          type: "SET_DRAWER_ATTACHMENT",
          index: Math.min(state.drawerAttachmentIdx + 1, attCount - 1),
        });
      } else if ((input === "k" || key.upArrow) && attCount > 1) {
        dispatch({ type: "SET_DRAWER_ATTACHMENT", index: state.drawerAttachmentIdx - 1 });
      } else if (input === "o" && selectedMsg) {
        // Open the SELECTED attachment in external viewer. If it isn't on disk
        // (transfer_state -1), first nudge Messages to download it (Stage 7).
        void openAttachmentWithNudge(
          selectedMsg,
          state.drawerAttachmentIdx,
          selected?.chatIdentifier,
          resolveInterpretConfig().nudge,
          dispatch,
        );
      } else if (input === "s" && selectedMsg) {
        void saveAttachmentWithNudge(
          selectedMsg,
          state.drawerAttachmentIdx,
          selected?.chatIdentifier,
          resolveInterpretConfig().nudge,
          dispatch,
        );
      } else if (input === "y" && selectedMsg) {
        const att = selectedMsg.attachments?.[state.drawerAttachmentIdx];
        if (att?.filename) {
          const filepath = att.filename.replace(/^~/, process.env.HOME ?? "~");
          execSync("pbcopy", { input: filepath });
          dispatch({ type: "SET_STATUS", status: "Attachment path copied." });
        } else {
          dispatch({ type: "SET_STATUS", status: "No attachment to copy." });
        }
      } else if (input === "f" && !key.ctrl && !key.meta && selectedMsg) {
        revealAttachment(selectedMsg, state.drawerAttachmentIdx, dispatch);
      } else if (input === "R" && selectedMsg) {
        void interpretMessage(selectedMsg, true);
      }
      return;
    }

    // Per-thread info / attachment drawer — j/k browse attachments; o/s/y act on
    // the selected one; a exports ALL; Esc/q closes. Owns all keys while open.
    if (state.mode === "info") {
      const attCount = state.infoAttachments.length;
      const idx = state.infoAttachmentIdx;
      const att = state.infoAttachments[idx];
      if (key.escape || input === "q") {
        dispatch({ type: "CLOSE_INFO_DRAWER" });
      } else if ((input === "j" || key.downArrow) && attCount > 1) {
        dispatch({ type: "SET_INFO_ATTACHMENT", index: idx + 1 });
      } else if ((input === "k" || key.upArrow) && attCount > 1) {
        dispatch({ type: "SET_INFO_ATTACHMENT", index: idx - 1 });
      } else if (input === "g" && attCount > 0) {
        dispatch({ type: "SET_INFO_ATTACHMENT", index: 0 });
      } else if (input === "G" && attCount > 0) {
        dispatch({ type: "SET_INFO_ATTACHMENT", index: attCount - 1 });
      } else if (input === "o") {
        if (att) {
          void nudgeAttachmentDownload(
            att,
            selected?.chatIdentifier,
            resolveInterpretConfig().nudge,
            dispatch,
          ).then((ok) => ok && openAttachmentFile(att, dispatch));
        } else dispatch({ type: "SET_STATUS", status: "No attachment." });
      } else if (input === "s") {
        if (att) {
          void nudgeAttachmentDownload(
            att,
            selected?.chatIdentifier,
            resolveInterpretConfig().nudge,
            dispatch,
          ).then((ok) => ok && saveAttachmentFile(att, dispatch));
        } else dispatch({ type: "SET_STATUS", status: "No attachment." });
      } else if (input === "y") {
        if (att?.filename) {
          execSync("pbcopy", { input: att.filename.replace(/^~/, process.env.HOME ?? "~") });
          dispatch({ type: "SET_STATUS", status: "Attachment path copied." });
        } else {
          dispatch({ type: "SET_STATUS", status: "No attachment to copy." });
        }
      } else if (input === "a") {
        saveAllAttachmentFiles(
          state.infoAttachments,
          `imsg-${selected?.threadSlug ?? "thread"}`,
          dispatch,
        );
      } else if (input === "f" && !key.ctrl && !key.meta) {
        if (att) revealAttachmentFile(att, dispatch);
        else dispatch({ type: "SET_STATUS", status: "No attachment." });
      }
      return;
    }

    // Settings panel — dedicated early-return guard (input-guard law): `q`
    // closes the PANEL, not the app. j/k move over selectable rows; space/←/→
    // edit the selected setting; K/J reorder a chain link. Providers are
    // read-only (no key entry in the TUI — wizard/file only).
    if (state.mode === "settings") {
      if (key.escape || input === "q") {
        dispatch({ type: "CLOSE_SETTINGS" });
      } else if (input === "j" || key.downArrow) {
        dispatch({
          type: "SET_SETTINGS_CURSOR",
          index: stepSelectable(settingsRows, state.settingsCursor, 1),
        });
      } else if (input === "k" || key.upArrow) {
        dispatch({
          type: "SET_SETTINGS_CURSOR",
          index: stepSelectable(settingsRows, state.settingsCursor, -1),
        });
      } else if (input === "g") {
        dispatch({ type: "SET_SETTINGS_CURSOR", index: firstSelectableIndex(settingsRows) });
      } else if (input === "G") {
        dispatch({ type: "SET_SETTINGS_CURSOR", index: lastSelectableIndex(settingsRows) });
      } else if (input === " " || key.return) {
        applySettings("toggle");
      } else if (input === "h" || key.leftArrow) {
        applySettings("left");
      } else if (input === "l" || key.rightArrow) {
        applySettings("right");
      } else if (input === "K") {
        applySettings("moveUp");
      } else if (input === "J") {
        applySettings("moveDown");
      }
      return;
    }

    // Date-jump modal mode — Esc cancels; Enter handled by TextInput.onSubmit
    if (state.mode === "date-jump") {
      if (key.escape) {
        dispatch({ type: "EXIT_DATE_JUMP" });
      }
      return;
    }

    // Send-via modal: digit picks an app + launches its URL-scheme deep link.
    if (state.mode === "send-via") {
      if (key.escape) {
        dispatch({ type: "EXIT_SEND_VIA" });
        return;
      }
      if (input && /^[1-9]$/.test(input) && selected) {
        const apps = getInstalledChatApps();
        const idx = Number.parseInt(input, 10) - 1;
        const app = apps[idx];
        if (app) {
          const lastMsgText = state.messages.length
            ? (state.messages[state.messages.length - 1]?.text ?? undefined)
            : undefined;
          const built = app.buildUri(selected.chatIdentifier, lastMsgText);
          if (built) {
            (await import("node:child_process"))
              .spawn("open", [built], { detached: true, stdio: "ignore" })
              .unref();
            dispatch({ type: "SET_STATUS", status: `Launched ${app.name}` });
          } else {
            dispatch({
              type: "SET_STATUS",
              status: `${app.name}: handle not compatible with this scheme`,
            });
          }
        }
        dispatch({ type: "EXIT_SEND_VIA" });
        setTimeout(() => dispatch({ type: "SET_STATUS", status: "" }), 2500);
      }
      return;
    }

    // Export-modal mode — Tab cycles format, Esc cancels.
    // Path text input + Enter handled by the inline TextInput inside the modal.
    if (state.mode === "export") {
      if (key.escape) {
        dispatch({ type: "EXIT_EXPORT_MODE" });
      } else if (key.tab) {
        const order: Array<"markdown" | "csv" | "json"> = ["markdown", "csv", "json"];
        const next = order[(order.indexOf(state.exportFormat) + 1) % order.length];
        dispatch({ type: "SET_EXPORT_FORMAT", format: next });
        // Update path extension to match new format
        const stripped = state.exportPath.replace(/\.(md|csv|json)$/, "");
        dispatch({ type: "SET_EXPORT_PATH", path: `${stripped}.${extensionFor(next)}` });
      }
      return;
    }

    // Select mode — V'd. j/k extend, Esc exits, e opens export modal,
    // y copies selected text to clipboard.
    if (state.mode === "select") {
      if (key.escape) {
        dispatch({ type: "EXIT_SELECT_MODE" });
        return;
      }
      if (input === "e") {
        const slug = selected?.threadSlug ?? "messages";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const defaultPath = join(homedir(), `imsg-export-${slug}-${stamp}.md`);
        dispatch({ type: "ENTER_EXPORT_MODE", defaultPath });
        return;
      }
      if (input === "y" && state.selectionAnchor != null) {
        const [lo, hi] = [
          Math.min(state.selectionAnchor, state.selectedMsgIdx),
          Math.max(state.selectionAnchor, state.selectedMsgIdx),
        ];
        const text = state.messages
          .slice(lo, hi + 1)
          .map(
            (m) =>
              `[${m.date.toISOString()}] ${m.isFromMe ? "Me" : (m.displayName ?? m.handle)}: ${m.text ?? "(no text)"}`,
          )
          .join("\n");
        try {
          execSync("pbcopy", { input: text });
          dispatch({ type: "SET_STATUS", status: `Copied ${hi - lo + 1} msgs` });
        } catch {
          dispatch({ type: "SET_STATUS", status: "Copy failed" });
        }
        setTimeout(() => dispatch({ type: "SET_STATUS", status: "" }), 2000);
        return;
      }
      // j/k/G/gg/{}/Ctrl-d/Ctrl-u/digits — fall through to browse-mode
      // movement (anchor stays). EVERYTHING ELSE stops here: the fall-through
      // used to reach every browse handler, so pressing q inside a selection
      // quit the whole app (input-guard-law violation, swarm finding A3-2).
      const selectMovement =
        input === "j" ||
        input === "k" ||
        input === "g" ||
        input === "G" ||
        input === "{" ||
        input === "}" ||
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && (input === "d" || input === "u")) ||
        /^[0-9]$/.test(input);
      if (!selectMovement) return;
    }

    // Browse mode
    if (input === "d" && !key.ctrl && !key.meta && state.mode === "browse") {
      dispatch({ type: "TOGGLE_DEV_STATS" });
      return;
    }
    // i — per-thread info / attachment drawer for the selected conversation.
    if (input === "i" && !key.ctrl && !key.meta && state.mode === "browse" && selected) {
      openInfoDrawer();
      return;
    }
    // , — open the settings panel (media-interpretation config). Also reachable
    // from the palette (core.settings). Loads config + credential presence.
    if (input === "," && !key.ctrl && !key.meta && state.mode === "browse") {
      openSettings(dispatch);
      return;
    }
    if (input === "V" && state.focus === "thread" && state.selectedMsgIdx >= 0) {
      dispatch({ type: "ENTER_SELECT_MODE" });
      return;
    }
    if (input === ":" && state.focus === "thread" && state.mode === "browse") {
      dispatch({ type: "ENTER_DATE_JUMP" });
      return;
    }
    // O — open the current thread in Messages.app via the imessage:// URL scheme.
    // For 1:1 chats this focuses or composes that thread. Groups have no URL
    // scheme — we fall back to AppleScript activate.
    if (
      input === "O" &&
      !key.ctrl &&
      !key.meta &&
      state.focus === "thread" &&
      state.mode === "browse" &&
      selected
    ) {
      const handle = selected.chatIdentifier;
      const uri = `imessage://${encodeURIComponent(handle)}`;
      (await import("node:child_process"))
        .spawn("open", [uri], { detached: true, stdio: "ignore" })
        .unref();
      dispatch({ type: "SET_STATUS", status: `Opened ${handle} in Messages.app` });
      setTimeout(() => dispatch({ type: "SET_STATUS", status: "" }), 2500);
      return;
    }
    // S — send-via picker: list installed external chat apps and let the user
    // launch one. Body is the most recent message text in the thread (best-
    // effort context); the URI carries it only on schemes that support body.
    if (
      input === "S" &&
      !key.ctrl &&
      !key.meta &&
      state.focus === "thread" &&
      state.mode === "browse" &&
      selected
    ) {
      dispatch({ type: "ENTER_SEND_VIA" });
      return;
    }
    if (input === "q") {
      // Record the cause explicitly: "user_quit" in the shutdown marker beats
      // the ambient "normal" — a postmortem can tell a deliberate quit from
      // any exit that merely recorded nothing.
      noteShutdownCause("user_quit");
      await imsg.close();
      exit();
      return;
    }
    if (input === "r") {
      await refreshAll();
      return;
    }
    // N (uppercase) opens compose-to-new-thread from anywhere in browse mode.
    // Distinct from `c` which composes WITHIN the currently-selected thread.
    if (input === "N" && state.mode === "browse") {
      dispatch({ type: "ENTER_COMPOSE_NEW" });
      return;
    }
    if (input === "c" || (key.return && state.focus === "thread" && state.mode === "browse")) {
      if (state.focus === "thread" && key.return && state.selectedMsgIdx >= 0) {
        // Enter on a message opens drawer
        dispatch({ type: "OPEN_DRAWER" });
        return;
      }
      // `c` from sidebar with no selected thread → fall through to compose-new
      // so the user always gets a meaningful action.
      if (state.focus === "sidebar" && !selected) {
        dispatch({ type: "ENTER_COMPOSE_NEW" });
        return;
      }
      dispatch({ type: "ENTER_COMPOSE" });
      return;
    }
    if (input === "/" && state.mode === "browse") {
      dispatch({ type: "ENTER_FILTER" });
      return;
    }
    if (key.tab) {
      dispatch({ type: "FOCUS", pane: state.focus === "sidebar" ? "thread" : "sidebar" });
      return;
    }

    if (state.loading) return;

    // Number buffer for vim-style counts (e.g. "12j" to jump 12 lines)
    if (/^[0-9]$/.test(input) && !key.ctrl && !key.meta) {
      // Don't buffer leading zeros unless building a number
      if (input === "0" && !state.numBuffer) {
        // '0' alone: go to first item (like vim)
        if (state.focus === "sidebar") {
          selectSidebarCombined(0);
        } else {
          dispatch({ type: "SELECT_MSG", index: 0 });
        }
        return;
      }
      dispatch({ type: "SET_NUM_BUFFER", value: state.numBuffer + input });
      return;
    }

    if (state.focus === "sidebar") {
      // Copy thread slug to clipboard (only meaningful for real conversations)
      if (input === "y" && selected) {
        try {
          execSync("pbcopy", { input: `~${selected.threadSlug}` });
          dispatch({ type: "SET_STATUS", status: `Copied ~${selected.threadSlug}` });
          setTimeout(() => dispatch({ type: "SET_STATUS", status: "" }), 2000);
        } catch {
          dispatch({ type: "SET_STATUS", status: "Failed to copy" });
        }
        return;
      }

      const count = getCount();
      const totalRows = sidebarRowCount(state);
      const lastIdx = Math.max(0, totalRows - 1);
      const curIdx =
        state.selectedModuleIdx != null
          ? state.selectedModuleIdx
          : state.moduleInstances.length + state.selectedIdx;
      let next: number | null = null;

      if (input === "j" || key.downArrow) {
        next = Math.min(curIdx + count, lastIdx);
      } else if (input === "k" || key.upArrow) {
        next = Math.max(curIdx - count, 0);
      } else if (input === "G") {
        next = lastIdx;
      } else if (input === "g") {
        // Handle gg (go to top)
        if (ggPendingRef.current) {
          ggPendingRef.current = false;
          if (ggTimerRef.current) clearTimeout(ggTimerRef.current);
          next = 0;
        } else {
          ggPendingRef.current = true;
          // 350ms is the typical vim chord window — feels snappy without
          // false-positive-firing on a slow second keypress. Was 500ms.
          ggTimerRef.current = setTimeout(() => {
            ggPendingRef.current = false;
          }, 350);
          return;
        }
      } else if (key.ctrl && input === "d") {
        next = Math.min(curIdx + Math.floor(bodyHeight / 2), lastIdx);
      } else if (key.ctrl && input === "u") {
        next = Math.max(curIdx - Math.floor(bodyHeight / 2), 0);
      } else if ((key.ctrl && input === "f") || key.pageDown) {
        next = Math.min(curIdx + bodyHeight, lastIdx);
      } else if ((key.ctrl && input === "b") || key.pageUp) {
        next = Math.max(curIdx - bodyHeight, 0);
      } else if (input === "H") {
        next = state.sidebarScroll;
      } else if (input === "M") {
        next = Math.min(state.sidebarScroll + Math.floor(bodyHeight / 2), lastIdx);
      } else if (input === "L") {
        next = Math.min(state.sidebarScroll + bodyHeight - 1, lastIdx);
      }

      if (next !== null && next !== curIdx) {
        selectSidebarCombined(next);
      }
    } else {
      // Thread focus — message cursor movement
      const count = getCount();

      if (input === "j" || key.downArrow) {
        dispatch({ type: "MOVE_MSG", delta: count });
      } else if (input === "k" || key.upArrow) {
        dispatch({ type: "MOVE_MSG", delta: -count });
      } else if (input === "G") {
        dispatch({ type: "SELECT_MSG", index: state.messages.length - 1 });
      } else if (input === "g") {
        if (ggPendingRef.current) {
          ggPendingRef.current = false;
          if (ggTimerRef.current) clearTimeout(ggTimerRef.current);
          dispatch({ type: "SELECT_MSG", index: 0 });
        } else {
          ggPendingRef.current = true;
          // 350ms is the typical vim chord window — feels snappy without
          // false-positive-firing on a slow second keypress. Was 500ms.
          ggTimerRef.current = setTimeout(() => {
            ggPendingRef.current = false;
          }, 350);
        }
      } else if (key.ctrl && input === "d") {
        dispatch({ type: "MOVE_MSG", delta: Math.floor(bodyHeight / 2) });
      } else if (key.ctrl && input === "u") {
        dispatch({ type: "MOVE_MSG", delta: -Math.floor(bodyHeight / 2) });
      } else if ((key.ctrl && input === "f") || key.pageDown) {
        dispatch({ type: "MOVE_MSG", delta: bodyHeight });
      } else if ((key.ctrl && input === "b") || key.pageUp) {
        dispatch({ type: "MOVE_MSG", delta: -bodyHeight });
      } else if (input === "H") {
        // Jump to top of visible area (approximate)
        const visibleTop = Math.max(0, state.selectedMsgIdx - Math.floor(bodyHeight * 0.7));
        dispatch({ type: "SELECT_MSG", index: visibleTop });
      } else if (input === "L") {
        const visibleBottom = Math.min(
          state.messages.length - 1,
          state.selectedMsgIdx + Math.floor(bodyHeight * 0.3),
        );
        dispatch({ type: "SELECT_MSG", index: visibleBottom });
      } else if (input === "M") {
        // Stay at current (middle)
      } else if (input === "}" || input === "]") {
        // Jump to next sender group
        const next = nextGroupBoundary(state.messages, state.selectedMsgIdx);
        dispatch({ type: "SELECT_MSG", index: next });
      } else if (input === "{" || input === "[") {
        // Jump to previous sender group
        const prev = prevGroupBoundary(state.messages, state.selectedMsgIdx);
        dispatch({ type: "SELECT_MSG", index: prev });
      } else if (input === "o") {
        // Open attachment for selected message. Always call so the no-msg/
        // no-attachment toast fires when the user presses `o` without a
        // valid selection — silent no-op is confusing UX. Messages with
        // MULTIPLE attachments open the drawer instead, where j/k selects
        // which one to open/save.
        const msg = state.selectedMsgIdx >= 0 ? state.messages[state.selectedMsgIdx] : undefined;
        if (msg && (msg.attachments?.length ?? 0) > 1) {
          dispatch({ type: "OPEN_DRAWER" });
          dispatch({
            type: "SET_STATUS",
            status: `${msg.attachments?.length} attachments — j/k select, o open, s save`,
          });
        } else {
          void openAttachmentWithNudge(
            msg,
            0,
            selected?.chatIdentifier,
            resolveInterpretConfig().nudge,
            dispatch,
          );
        }
      } else if (input === "R") {
        // Interpret (transcribe / caption) the selected message's media on
        // demand. Explicit keypress → force past the auto-mode gate.
        const msg = state.selectedMsgIdx >= 0 ? state.messages[state.selectedMsgIdx] : undefined;
        void interpretMessage(msg, true);
      }
    }
  };
  // Ink re-registers on every render; the ref keeps the fan-out wrapper
  // pointing at the CURRENT closure (same freshness the inline handler had).
  handleKeyRef.current = handleKey;

  // ── Date jump ──────────────────────────────────────────────────────

  const MAX_JUMP_BATCHES = 100; // bounded loop: 100 × 100 = 10,000 messages

  const doDateJump = useCallback(
    async (input: string) => {
      const target = parseUserDate(input);
      if (!target) {
        dispatch({
          type: "SET_DATE_JUMP_ERROR",
          error: `Could not parse "${input}". Try YYYY-MM-DD or "1 week ago".`,
        });
        return;
      }
      if (!selected) {
        dispatch({ type: "EXIT_DATE_JUMP" });
        return;
      }
      let batches = 0;
      // Drive the loop off LOCAL cursor + each fetch's return value — never the
      // captured `state`, which is a frozen closure snapshot here: reading
      // state.messages/state.messageOldestLoadedId inside the loop made it
      // blind to its own dispatched prepends, so it either spun re-fetching the
      // same page or broke before the first fetch (older history unreachable).
      let cursor = state.messageOldestLoadedId;
      let oldestDate = state.messages.length > 0 ? state.messages[0].date : new Date();
      // Loop: load older messages until oldest <= target, or exhausted.
      while (batches < MAX_JUMP_BATCHES && cursor != null && cursor !== -1 && oldestDate > target) {
        const older = await imsg.loadOlderMessages(selected.chatIdentifier, cursor);
        if (older.length === 0) break;
        const next = oldestMessageCursor(older) ?? -1;
        let batchOldest = older[0].date;
        for (const m of older) if (m.date < batchOldest) batchOldest = m.date;
        // No-progress guard: the batch reached no further back than the cursor.
        if (next === cursor || next === -1 || batchOldest >= oldestDate) break;
        dispatch({ type: "PREPEND_MESSAGES", data: older, oldestId: next });
        cursor = next;
        oldestDate = batchOldest;
        batches++;
        // Yield to render between batches
        await new Promise((r) => setTimeout(r, 10));
      }
      // Select the first message at/after target against the LIVE state (the
      // reducer sees the just-prepended messages; this closure does not).
      dispatch({ type: "SELECT_MSG_BY_DATE", date: target });
      dispatch({ type: "EXIT_DATE_JUMP" });
      dispatch({
        type: "SET_STATUS",
        status:
          batches >= MAX_JUMP_BATCHES
            ? `Jumped (capped) — load more manually for older history`
            : `Jumped to ${formatJumpTarget(target)}`,
      });
      setTimeout(() => dispatch({ type: "SET_STATUS", status: "" }), 4000);
    },
    [imsg, selected, state.messages, state.messageOldestLoadedId],
  );

  // ── Export action ──────────────────────────────────────────────────

  const doExport = useCallback(() => {
    const messagesToExport =
      state.selectionAnchor != null
        ? state.messages.slice(
            Math.min(state.selectionAnchor, state.selectedMsgIdx),
            Math.max(state.selectionAnchor, state.selectedMsgIdx) + 1,
          )
        : state.messages;
    if (messagesToExport.length === 0) {
      dispatch({ type: "SET_STATUS", status: "Nothing to export" });
      return;
    }
    const expandedPath = state.exportPath.replace(/^~/, homedir());
    try {
      let content: string;
      const header = {
        thread: selected?.displayName ?? selected?.chatIdentifier ?? "thread",
        participants: selected?.participants ?? [],
        serviceType: selected?.serviceType,
      };
      switch (state.exportFormat) {
        case "markdown":
          content = toMarkdown(messagesToExport, header);
          break;
        case "csv":
          content = toCSV(messagesToExport);
          break;
        case "json":
          content = toJSON(messagesToExport, header);
          break;
      }
      writeFileSync(expandedPath, content, "utf8");
      dispatch({ type: "EXIT_EXPORT_MODE" });
      dispatch({ type: "EXIT_SELECT_MODE" });
      dispatch({
        type: "SET_STATUS",
        status: `Exported ${messagesToExport.length} msgs to ${expandedPath}`,
      });
      setTimeout(() => dispatch({ type: "SET_STATUS", status: "" }), 4000);
    } catch (err) {
      dispatch({
        type: "SET_STATUS",
        status: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [
    state.exportFormat,
    state.exportPath,
    state.messages,
    state.selectedMsgIdx,
    state.selectionAnchor,
    selected,
  ]);

  // ── Open attachment ────────────────────────────────────────────────

  /** Load thread stats + all attachments (sync DB reads), then open the drawer. */
  function openInfoDrawer() {
    if (!selected) {
      dispatch({ type: "SET_STATUS", status: "No conversation selected." });
      return;
    }
    try {
      const stats = imsg.getChatStats(selected.chatIdentifier);
      const attachments = imsg.listConversationAttachments(selected.chatIdentifier);
      // Group-system events (renames, joins/leaves) exist only for groups.
      const events = selected.isGroupChat
        ? imsg.getConversationEvents(selected.chatIdentifier, 6)
        : [];
      dispatch({ type: "OPEN_INFO_DRAWER", stats, attachments, events });
    } catch (e) {
      dispatch({
        type: "SET_STATUS",
        status: `Info failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // ── Mouse ──────────────────────────────────────────────────────────

  // Wheel events are COALESCED: a physical wheel flick / trackpad momentum
  // swipe arrives as dozens of SGR events in a burst, and dispatching one
  // MOVE_MSG per event meant one full render per wheel notch — the cursor
  // teleported, and at the top of a thread every render cycle re-fired the
  // older-messages pagination (the memory-blowup path that RSS-killed a real
  // session). Deltas accumulate per pane and flush as ONE clamped dispatch
  // per WHEEL_FLUSH_MS window.
  const WHEEL_FLUSH_MS = 40;
  const WHEEL_MAX_STEP = 15;
  const wheelAccum = useRef({ sidebar: 0, thread: 0 });
  const wheelFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushWheel = useCallback(() => {
    wheelFlushTimer.current = null;
    const { sidebar, thread } = wheelAccum.current;
    wheelAccum.current = { sidebar: 0, thread: 0 };
    const clamp = (d: number) => Math.max(-WHEEL_MAX_STEP, Math.min(WHEEL_MAX_STEP, d));
    if (sidebar !== 0) dispatch({ type: "SCROLL_SIDEBAR", delta: clamp(sidebar) });
    if (thread !== 0) dispatch({ type: "MOVE_MSG", delta: clamp(thread) });
  }, []);

  useEffect(() => {
    return () => {
      if (wheelFlushTimer.current) clearTimeout(wheelFlushTimer.current);
    };
  }, []);

  const handleMouse = useCallback(
    (event: { type: string; x: number; y: number }) => {
      if (event.type === "click") {
        if (event.x <= sidebarWidth) {
          dispatch({ type: "FOCUS", pane: "sidebar" });
          // Combined index covers [...moduleInstances, ...conversations].
          const combinedIdx = Math.floor((event.y - 2 + state.sidebarScroll * 3) / 3);
          const moduleCount = state.moduleInstances.length;
          if (combinedIdx >= 0 && combinedIdx < moduleCount + state.conversations.length) {
            selectSidebarCombined(combinedIdx);
          }
        } else {
          dispatch({ type: "FOCUS", pane: "thread" });
        }
      } else if (event.type === "scroll-up" || event.type === "scroll-down") {
        const step = event.type === "scroll-up" ? -1 : 1;
        if (event.x <= sidebarWidth) wheelAccum.current.sidebar += step;
        else wheelAccum.current.thread += step;
        if (!wheelFlushTimer.current) {
          wheelFlushTimer.current = setTimeout(flushWheel, WHEEL_FLUSH_MS);
        }
      }
    },
    [
      sidebarWidth,
      state.sidebarScroll,
      state.conversations.length,
      state.moduleInstances.length,
      selectSidebarCombined,
      flushWheel,
    ],
  );

  useMouse(handleMouse);

  // ── Cleanup ────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (moveDebounceRef.current) clearTimeout(moveDebounceRef.current);
      if (ggTimerRef.current) clearTimeout(ggTimerRef.current);
    };
  }, []);

  // ── Render ─────────────────────────────────────────────────────────

  // Resolve the module + its pane renderer when a virtual row is selected.
  const selectedModuleDef = selectedModule ? findModule(selectedModule.moduleId) : undefined;
  const ModulePane = selectedModuleDef?.Pane;

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      {/* Main layout */}
      <Box flexGrow={1} height={bodyHeight}>
        {state.mode === "settings" ? (
          <SettingsPanel
            rows={settingsRows}
            cursor={state.settingsCursor}
            configPath={state.settingsConfigPath}
            warnings={state.settingsWarnings}
            width={columns}
            height={bodyHeight}
          />
        ) : (
          <>
            <Sidebar
              conversations={state.conversations}
              moduleInstances={state.moduleInstances}
              selectedIdx={state.selectedIdx}
              selectedModuleIdx={state.selectedModuleIdx}
              filterCursor={state.filterCursor}
              scrollOffset={state.sidebarScroll}
              filterQuery={state.filterQuery}
              focused={state.focus === "sidebar"}
              width={sidebarWidth}
              height={bodyHeight}
              loading={state.loading}
            />
            {selectedModule && ModulePane ? (
              <ModulePane
                instance={selectedModule}
                imsg={imsg}
                width={threadWidth}
                height={bodyHeight}
                focused={state.focus === "thread"}
                onUpdateState={(next) =>
                  dispatch({
                    type: "UPDATE_MODULE_INSTANCE_STATE",
                    instanceId: selectedModule.id,
                    state: next,
                  })
                }
                onClose={() =>
                  dispatch({ type: "CLOSE_MODULE_INSTANCE", instanceId: selectedModule.id })
                }
                setStatus={(s) => {
                  dispatch({ type: "SET_STATUS", status: s });
                  setTimeout(() => dispatch({ type: "SET_STATUS", status: "" }), 2500);
                }}
              />
            ) : (
              <ThreadPane
                conversation={selected}
                messages={state.messages}
                pending={state.pending}
                resolvedNames={resolvedNames}
                scrollOffset={state.threadScroll}
                selectedMsgIdx={state.selectedMsgIdx}
                selectionAnchor={state.selectionAnchor}
                gapMarkers={state.gapMarkers}
                focused={state.focus === "thread"}
                width={threadWidth}
                height={bodyHeight}
                mode={state.mode}
                onChangeCompose={(text) => dispatch({ type: "UPDATE_COMPOSE", text })}
                onSubmitCompose={(text) => text.trim() && dispatch({ type: "CONFIRM_SEND" })}
                loading={state.loading}
              />
            )}
            {state.mode === "drawer" && selectedMsg && (
              <MessageDrawer
                message={selectedMsg}
                width={drawerWidth}
                height={bodyHeight}
                selectedAttachmentIdx={state.drawerAttachmentIdx}
                reactionNames={reactionNames}
              />
            )}
            {state.mode === "info" && selected && (
              <InfoDrawer
                conversation={selected}
                resolvedNames={resolvedNames}
                stats={state.infoStats}
                events={state.infoEvents}
                attachments={state.infoAttachments}
                selectedAttachmentIdx={state.infoAttachmentIdx}
                width={drawerWidth}
                height={bodyHeight}
              />
            )}
            {state.showDevStats && <DevStats stats={devStats} width={devStatsWidth} />}
          </>
        )}
      </Box>

      {/* Date-jump modal */}
      {state.mode === "date-jump" && (
        <DateJumpModal
          value={state.dateJumpInput}
          error={state.dateJumpError}
          onChange={(v) => dispatch({ type: "SET_DATE_JUMP_INPUT", value: v })}
          onSubmit={(v) => doDateJump(v)}
        />
      )}

      {/* Send-via picker — launch external chat apps for the current thread */}
      {state.mode === "send-via" && selected && (
        <SendViaModal handle={selected.chatIdentifier} apps={getInstalledChatApps()} />
      )}

      {/* Compose-to-new-thread modal — `N` (or `c` from sidebar with no
          selected thread). Two-stage: recipient input → message body. */}
      {state.mode === "compose-new" && (
        <ComposeRecipientModal
          resolve={imsg.resolveRecipientInput}
          onSend={async (handle, text) => {
            const result = await imsg.sendToRecipient(handle, text);
            if (result.success) {
              dispatch({
                type: "SET_STATUS",
                status: `Sent to ${handle}`,
              });
              // Trigger a refresh so the new conversation shows up in the sidebar.
              await refreshAll();
            }
            return result;
          }}
          onCancel={() => dispatch({ type: "EXIT_COMPOSE_NEW" })}
        />
      )}

      {/* Export modal — overlays the bottom of the body when active */}
      {state.mode === "export" && (
        <ExportModal
          format={state.exportFormat}
          path={state.exportPath}
          rangeSummary={(() => {
            if (state.selectionAnchor != null) {
              const lo = Math.min(state.selectionAnchor, state.selectedMsgIdx);
              const hi = Math.max(state.selectionAnchor, state.selectedMsgIdx);
              const n = hi - lo + 1;
              return `${n} selected message${n === 1 ? "" : "s"}`;
            }
            const m = state.messages.length;
            return `entire loaded thread (${m} message${m === 1 ? "" : "s"})`;
          })()}
          onChangePath={(p) => dispatch({ type: "SET_EXPORT_PATH", path: p })}
          onSubmit={doExport}
        />
      )}

      {/* Command palette — overlay modal, Ctrl-P / ? from browse mode. */}
      {state.mode === "palette" && (
        <CommandPalette
          commands={commands}
          query={state.paletteQuery}
          cursor={state.paletteCursor}
          width={columns}
          height={rows}
          ctx={commandCtx}
          onQueryChange={(q) => dispatch({ type: "SET_PALETTE_QUERY", query: q })}
          onCursorMove={(d) => dispatch({ type: "MOVE_PALETTE_CURSOR", delta: d })}
          onSelectCursor={(i) => dispatch({ type: "SET_PALETTE_CURSOR", index: i })}
          onClose={() => dispatch({ type: "CLOSE_PALETTE" })}
        />
      )}

      {/* Status + Help */}
      <StatusBar
        totalUnread={totalUnread}
        selected={selected}
        status={state.status}
        loading={state.loading}
      >
        {!state.showDevStats && <CompactStats stats={devStats} />}
      </StatusBar>
      {/* flexShrink=0 wrapper: when a modal makes this column taller than
          the terminal, yoga must squeeze the BODY, never the 1-line bars —
          a height-0 box still paints its text over the row below. The pin
          lives HERE (vertical flex context) because on HelpBar's own root
          it would also block horizontal shrink-to-terminal-width, undoing
          the mid-hint-wrap fix. StatusBar pins its own root (always
          full-width, so no width conflict). */}
      <Box flexShrink={0} height={1}>
        <HelpBar mode={state.mode} focus={state.focus} />
      </Box>
    </Box>
  );
}
