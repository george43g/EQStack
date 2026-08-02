# Real-time streaming, memory-efficient scroll & Messages API-surface audit

**Status:** Research / recommendations (not started). Written 2026-07-30 from a review of the
Messages.app API surface (osascript / URI / System Events / `chat.db`) and a code audit of what
imsg-mcp already exposes vs. what's missing. Feeds **Backlog §9** in [`../STATUS.md`](../STATUS.md).

This doc answers three questions:
1. Should we replace `chat.db` polling with a **worker that watches the DB and streams events** (an
   observable) to every frontend (TUI / console / MCP)?
2. Why does the TUI **run out of memory on long scroll**, and can infinite-scroll stream just-in-time
   with **cache-hit metrics**?
3. Which Messages API-surface features are **missing or inadequately implemented without good reason**?

---

## Part A — Real-time event streaming (the observable vision)

### Current state (verified)
Everything is **poll-based**; there is no file-watching anywhere in `src/`:
- `wait_for_reply` polls `chat.db` every `pollIntervalSeconds` (`src/index.ts:1044-1118`), using
  `getMessagesAfter(afterMessageId)` (`src/imessage-db.ts:900`, *"for polling new messages"*).
- The TUI refreshes on user action / re-entry; the smart cache (`src/tui/messageCache.ts`) has a 30s
  staleness window but no push.
- `attachment-sync.ts` polls the filesystem for a downloaded attachment.

So the user's instinct is right: reactivity today is manual/interval, which is both laggy and the
source of "ugly" refresh code.

### Recommended architecture — a core observable fed by a WAL watcher
```
 chat.db-wal ──(fs.watch / FSEvents)──▶ ChangeWatcher (core, src/)
                                          │  debounce ~150ms
                                          │  read rows WHERE rowid > highWaterRowid
                                          │  (REUSES IMessageDB.getMessagesAfter — no new parser)
                                          ▼
                                   EventBus (typed, framework-agnostic)
                                     emits: message.new | message.edited |
                                            message.unsent | message.read |
                                            reaction | group.renamed |
                                            group.member_added | group.member_removed
                    ┌───────────────────────┼───────────────────────┐
              TUI (useSyncExternalStore)  console (print loop)   MCP (see below)
```
Key properties:
- **Single detection primitive.** Watch the **WAL file** (`chat.db-wal`) — SQLite appends there
  before checkpointing. A write event triggers a **delta read** keyed on a high-water `ROWID`
  (and, for mutations, `date_edited` / `is_read` deltas). `fs.watch` is coalescing and cheap; keep a
  short debounce because one logical message = several WAL writes.
- **No duplicated parsing layer.** The watcher's delta-reader calls the **same** `IMessageDB`
  methods the initial UI load uses (`getMessagesAfter`, `convertMessage`, the attributed-body /
  edit-history parsers). The stream is "poll-for-rows-after-high-water, but triggered by a write
  instead of a timer." This is the explicit design constraint: **one parser, two callers**
  (initial-state load + event streamer).
- **Core owns it; frontends only render** — matches the existing architecture rule (all processing
  in `src/`, frontends render). The EventBus is a plain `EventEmitter` / async-iterator, no React.

### "Just detect a write and refresh" vs. a real event stream — the efficiency question
The user asked whether simply signalling "the DB changed, TUI re-refresh" is *"a lot less
efficient"* than streaming typed events. Answer:
- **The detection primitive is identical** — both watch `chat.db-wal`. Watching is not the cost.
- The difference is the **reaction**:
  - *Dumb refresh*: re-query the whole current viewport (and re-diff/re-render) on every write.
    O(viewport) work per event, and it throws away the very information the WAL already gave you
    (which rows changed).
  - *Event stream*: read only rows past the high-water `ROWID` and **append/patch** them. O(delta)
    work — usually 1 row — and the renderer can do an incremental update instead of a full re-render.
- So the dumb-refresh is a strict subset that does **more** render work, not less. Since you must
  do the delta query anyway to know *what* changed, emitting it as an event is nearly free.
  **Recommendation: build the event stream; the "just refresh" fallback is only worth it as a
  degenerate mode if `fs.watch` is unavailable.**

### Observable vs. React hooks
The user is correct that hooks are the wrong seam for a cross-frontend push source:
- The right React primitive is **`useSyncExternalStore`** (subscribe + getSnapshot), not a bespoke
  `useEffect`+`useState` hook — it's designed exactly for an external mutable store and avoids
  tearing. The TUI would wrap the core EventBus in a tiny store adapter.
- Console / a future web dashboard subscribe to the same EventBus with no React at all (async
  iterator / callback). A web dashboard would bridge it to SSE or WebSocket at the edge — the core
  stays framework-agnostic.

### MCP exposure
MCP has no native server→model push for arbitrary events, but two clean options:
- **`wait_for_changes` tool** — a long-poll that blocks on the EventBus (like `wait_for_reply` but
  for any mutation type), returning a batch of typed events. Honors `notifications/cancelled`.
- **Resource `listChanged` / resource-updated notifications** — emit MCP resource-update
  notifications when a watched conversation changes, so subscribing hosts refresh. Lighter, but
  host-dependent.

### Risks / notes
- **Full Disk Access** is already required to read `chat.db`; watching `chat.db-wal` needs the same.
- WAL checkpointing can truncate/rename the WAL — the watcher must re-`stat`/re-open on `rename`
  events, and reconcile via the high-water `ROWID` (never trust the file offset).
- Backpressure: coalesce bursts (a bulk sync writes thousands of rows) into batched emits.

---

## Part B — Memory-efficient infinite scroll + cache-hit metrics

### Current state (verified)
There is already bounded memory, but the user still OOMs on long scroll:
- **Bounded message window** (`src/tui/types.ts:234`): `MESSAGES_HARD_CAP` (default 5000) evicts the
  *middle* of the array into gap markers, preserving head+cursor regions.
- **Smart cache** (`src/tui/messageCache.ts`): per-chat entries, 30s stale window, 60s TTL sweep,
  and LRU-half eviction when heap > `IMSG_TUI_CACHE_MEM_PRESSURE_MB` (200MB).
- **But there is no hit-rate instrumentation** — `cacheStats()` reports only `{entries, bytes}`,
  not hits/misses. The user's "% cache hit" logging **does not exist yet**.

### Why it still crashes — hypotheses to investigate
1. **Ink render-tree growth is the likely real culprit.** Bounding the *data* array doesn't bound the
   *rendered element tree* if `ThreadPane` maps all in-window messages to Ink nodes. Ink diffs a
   retained tree; a 5000-row map with frequent re-renders can blow heap regardless of the data cap.
   → **Virtualize the viewport**: render only the visible slice (+ small overscan), not the whole
   window. This is the highest-leverage fix and pairs naturally with the streaming window below.
2. **Cache accumulation across chats** — LRU-half eviction only fires at 200MB, which may already be
   near the crash point. Consider an entry-count cap and earlier/steeper eviction.
3. **Gap-reload re-expansion** — scrolling back re-hydrates evicted regions; if the cap isn't
   re-applied promptly after `loadOlderMessages`, the array can exceed `HARD_CAP` transiently.

### Proposal
- **Viewport virtualization** in `ThreadPane` (render visible + overscan only). Bounds Ink memory
  independent of history length.
- **Streaming window / ring buffer**: keep an explicit windowed store fed just-in-time from the DB
  (and, once Part A lands, from the event stream). Data for a viewport streams in moments before
  render and is dropped once pushed off the window edge.
- **Cache-hit metrics**: add `hits`/`misses`/`evictions` counters to `messageCache.ts`, expose via
  `cacheStats()`, render in the dev-stats panel (`d`), and emit a periodic `perf`-level log line
  (`cache_hit_rate`) so we can tune window sizes against real scroll patterns.
- Keep it all in core/TUI-state modules; components stay render-only.

---

## Part C — Messages API-surface feature audit (done vs. gap)

Grounded in `src/applescript.ts`, `src/imessage-db.ts`, `src/mcp-*.ts`, and the TUI components.

| Capability | State | Evidence / action |
|---|---|---|
| **Send text (iMessage/SMS, service-aware)** | ✅ done | `applescript.ts` sends on the thread's real service. |
| **Send attachments (1:1)** | ✅ done | `send_message.attachments` (`mcp-tools.ts:193`), `send (POSIX file …)` with sandbox-dir staging. **Group file-send is unreliable** (documented) — keep as known limitation. |
| **Edited messages (+ history + date)** | ✅ done | `isEdited`/`editHistory` (`types.ts`, `edit-history.ts`), rendered `MessageBubble.tsx:210`, `MessageDrawer.tsx:140`. |
| **Unsent / retracted shown as "unsent"** | ✅ done | `plist-text.ts` + `edit-history.ts` (`"rp"`); rendered `MessageBubble.tsx:213`, `MessageDrawer.tsx:130`. |
| **Read receipts (`dateRead`)** | ⚠️ partial | Surfaced in MCP (`mcp-format.ts:90`) + drawer (`MessageDrawer.tsx:93`). **Not a first-class bubble indicator, no reactive event.** Enhance (esp. under Part A). |
| **Group joins / leaves** | ❌ GAP | **Filtered out.** `isHiddenSystemItem(itemType)` drops every `item_type != 0` row; SQL filters `COALESCE(m.item_type,0)=0` (`imessage-db.ts:140,525,664,804`). Never surfaced anywhere. |
| **Group renames** | ❌ GAP | Same filter — group-name-change rows (`item_type`/`group_action_type`) are discarded. |
| **MMS vs iMessage per message** | ⚠️ weak-but-useful | `message.service` is captured. It's unreliable (MMS+SMS both report `SMS`), but the user's point stands: **glitchy data is still queryable under a ruleset.** Add a derived `serviceConfidence` / heuristic (attachments+group ⇒ likely MMS; `service` + handle domain) rather than dropping it. |
| **`activate` (bring Messages.app to front)** | ⚠️ used, not exposed | See note below. Cheap to mirror as an explicit affordance. |
| **New-message reactivity** | ❌ poll-only | Part A. |

### What is `activate`?
`tell application "Messages" to activate` simply **launches Messages.app if it isn't running and
brings it to the foreground** (standard AppleScript app command). The repo already calls it
(`applescript.ts:246`) before UI-scripting and before opening a conversation URL, because Messages
must be *running* to send and *frontmost* for System-Events UI scripting. Worth exposing as an
explicit primitive (e.g. an `open_conversation`/`focus_messages` affordance) since it's reliable and
underpins the sync-nudge and any future UI automation.

### Group-action surfacing — recommended shape
Rather than injecting group-action rows into the normal message stream (which would disrupt
analytics/exports), decode them into a **typed `ConversationEvent`** (`member_added`,
`member_removed`, `renamed`, with actor + target + timestamp) available via:
- a new `list_conversation_events` MCP tool / a field on conversation info,
- inline TUI system-line rows ("Alice added Bob", "George named the group 'Weekend Crew'"),
- and (Part A) live `group.*` events.
Keep the default message queries filtering `item_type=0` so existing metrics are unaffected; expose
events through the dedicated path.

---

## Part D — Rust `attributed_body` parser: leaked examples + the "rewrite" intent

Two findings in `native/src/attributed_body.rs` (verified):
1. **It is the persisted "hacked-together" parser.** The header comment states: *"This is a
   simplified initial implementation that extracts readable text from attributedBody BLOBs using
   heuristic string extraction. A full typedstream binary parser will be added in a later phase."*
   The intended proper rewrite never landed on the Rust side, even though the **TypeScript** side has
   a structured `TypedStreamParser` (`src/parsers/typedstream-parser.ts`). So the two engines use
   **different strategies** (structured TS vs. heuristic Rust) for the same job — a correctness and
   maintenance smell (their outputs can diverge on edge cases).
2. **Real-message-derived example fragments in comments.** The doc comments illustrate heuristics
   with snippets that read like real message text — e.g. *"Imagine…"* (described as an 82-char
   message), *"Heres the question"*, *"Heres"*. No names/numbers/PII, but message *content* fragments
   should not live in published source (project rule: never commit real personal data).

### Recommendations
- **Scrub the examples** — replace real-looking fragments with clearly-synthetic ones
  (e.g. `"Lorem ipsum…"`, `"Aardvark"`). Low-effort, do soon. Note the originals are already in git
  history; scrubbing head is still correct, and avoids re-publishing.
- **Unify on one structured parser** — port the Rust accelerator to mirror the TS `TypedStreamParser`
  algorithm (structured typedstream decode) so both engines agree, then delete the heuristic
  byte-scan path. Guard with a differential test: for a corpus of blobs, `native == TS` output.
  Bigger effort — schedule after the streaming work; it does **not** block anything.
- **Do not fork the parser for the event streamer** (Part A) — the streamer reuses whichever engine
  `native-bridge` selects, exactly like the initial load.

---

## Suggested priority
1. **P1 — Cache-hit metrics + viewport virtualization** (fixes the actual OOM the user hits).
2. **P1/P2 — Core `ChangeWatcher` + EventBus** (WAL watch → typed events; reuse `getMessagesAfter`),
   then wire TUI (`useSyncExternalStore`) and an MCP `wait_for_changes` tool.
3. **P2 — Group-action events** (`ConversationEvent` decode + surfaces).
4. **P2 — Scrub Rust comment examples** (quick privacy hygiene); **P3 — unify on one structured
   parser**.
5. **P3 — `serviceConfidence` heuristic for MMS/iMessage; explicit `focus_messages`/`activate`
   affordance; first-class read-receipt indicator.**

None of this is started; all of it is additive to the current polling design.
