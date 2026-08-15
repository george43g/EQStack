# imsg-mcp — Status & Backlog

_Single source of truth for where the project stands and what's still open. Read this
first when resuming work. Supersedes the retired `HANDOFF_v1.4.x.md`, `DEFERRED_TASKS.md`,
and the untracked `.tui-audit-notes.md` scratch files (folded in here, shipped items dropped)._

_Last updated 2026-08-16 · current release **v1.21.7** (npm; #91 observability markers in flight)._

> **🖥️ Claude Desktop / distribution / online-MCP:** the `.mcpb type:node` extension crashes in
> Desktop (Electron has no in-process SQLite); iMessage works there today via a **manual `mcpServers`
> entry on system node**. Root cause, the working setup, the `bun type:binary`
> distribution decision, and George's **online/remote-MCP (StreamableHTTP + tunnel + OAuth)** idea are
> all captured in **[`CLAUDE_DESKTOP_AND_ONLINE_MCP.md`](../apps/imsg-mcp/docs/CLAUDE_DESKTOP_AND_ONLINE_MCP.md)**.

> **✅ Monorepo conversion COMPLETE (2026-08-03).** The repo is now the **EQStack** pnpm-workspaces +
> Turborepo monorepo: the imsg app lives in `apps/imsg-mcp/`, the blank relationship-analysis shell
> in `apps/analysis/`, shared `@eqstack/*` config packages in `packages/`. Conversion record +
> progress log: **[`../HANDOFF.md`](../HANDOFF.md)**; design/why:
> [`MONOREPO_MIGRATION.md`](MONOREPO_MIGRATION.md). The published npm package stays `imsg-mcp`;
> the GitHub repo rename to EQStack remains George-triggered.

---

## Where things stand

`imsg-mcp` is feature-complete for its v1 goal: an MCP server + CLI + TUI that lets an agent
read, search, send, analyse, and export iMessage/SMS entirely on-device, behind a self-healing
watchdog. The **finalise cycle (v1.6.0 → v1.8.0)** closed every remaining v1.4.2-plan feature, and
the **Media-Intel cycle (v1.9.0 → v1.15.0)** made the tool *understand* media — Apple-native
transcripts/Genmoji text, a provider-agnostic AI interpretation layer with permanent caching
exposed uniformly across MCP/CLI/TUI, an `imsg setup` wizard + TUI settings panel, edit-history,
and a best-effort attachment sync nudge. The **feedback cycle (v1.15.1 → v1.19.0)** then closed the
#212–218 backlog: 3 TUI bugs (PR #41, v1.15.1), `search_contacts` relevance ranking (#42, v1.16.0),
`get_messages` scope signal + identifier over-match fix (#43, v1.17.0), list completeness metadata
`truncated`/`totalAvailable` (#44, v1.18.0), and a normalized identity block + E.164 on
`get_contact`/`resolve_handle` (#45, v1.19.0). A Desktop-hardening detour shipped v1.19.1/v1.19.2
(node:sqlite fallback, Electron detection, XDG fix — see the Desktop banner above). The
**monorepo/turborepo migration is DONE (2026-08-03)** — a corpus-consumer restructure for the future
relationship-analytics app; record in [`../HANDOFF.md`](../HANDOFF.md), design in
[`MONOREPO_MIGRATION.md`](MONOREPO_MIGRATION.md). The **kit-adoption + realtime cycle (v1.19.3 → v1.21.0,
2026-08-09/10)** then (a) fixed per-package publishing for real (msr tag-format, pnpm publish
plugin, `.mcpb` staging — three `workspace:*`-vs-npm landmines, AGENTS.md § Releasing), (b) replaced
the local watchdog/shutdown/color/useMouse/logger with thin wrappers over the published
`@george43g/robustness@0.6.0` + `@george43g/tui-kit@0.3.3` kits — **logs now redact phones/secrets
by default** (v1.19.4), (c) shipped cache hit-rate metrics + incremental ThreadPane lookup
(v1.20.0), and (d) landed the realtime stack (v1.21.0): core `ChangeWatcher` (WAL fs.watch →
high-water ROWID delta) + typed `EventBus`, **live TUI updates** via `useSyncExternalStore` (no more
manual `r`), a `wait_for_changes` MCP long-poll tool, and `wait_for_reply` waking on bus events
instead of pure polling. Stress-mcp now runs in CI (macOS + a linux TS-fallback job) with pack-size
and README-drift guards, and the screenshots workflow is honest for the first time (ink CI-mode +
two masking layers — see the 2026-08-10 HANDOFF entry). The **reliability cycle (v1.21.1 → v1.21.3)** then
took the TUI from "less reliable than Messages.app" to stable under abuse: a 5-agent swarm drove
every feature against the real DB while heap snapshots hunted the memory class. It killed the
session-ending heap leak (React's *development* reconciler emitting `performance.measure()` forever
because the bin ran with `NODE_ENV` unset), an analytics re-fetch loop, `q`-quits-the-app in
visual-select, merged-thread pagination that stranded tens of thousands of messages, a dead date
jump, wheel-scroll render storms, dropped keystrokes on fast scrolling, and — the one that made
live streaming look broken on every real Mac — a directory watch that macOS silently never delivers
on the TCC-protected `~/Library/Messages`.

The **correctness + boot cycle (v1.21.4 → v1.21.7, 2026-08-16)** continued the same loop solo,
driving the TUI in tmux against the real DB. It found that MCP `get_messages` had been handing
agents a pagination cursor that silently skipped history (§8c — up to 193 messages per page turn),
that the TUI painted nothing for ~2s on launch and then *lied* with "No conversations", that
cancelling a filter hijacked the user's selection, that the info drawer listed one person twice
while never naming a group, and that the single query behind boot was numbering all 408k messages
in the database to keep one per chat (§8b). Every fix was measured before and after on real data;
one candidate optimisation was benchmarked, found to be noise, and deliberately dropped. Boot went
from a blank screen until 3.9s to a labelled frame at 2.1s with data at 3.2s.

### Shipped in the finalise cycle (v1.6.0 → v1.8.0)

| Feature | Release | Notes |
|---|---|---|
| **Unsent-message detection** | v1.6.0 | `date_retracted` is 0 across the DB on current macOS; content-absence heuristic (`isUnsentMessage`) fixes inverted `isEdited`/`isRetracted`. Renders "⊘ unsent" in TUI/drawer + `[UNSENT …]` in MCP. |
| **`resolve_conversation`** | v1.6.0 | Free-form name → ranked threads in ONE call (fuses contacts + thread names + message content). MCP tool + `imsg resolve` CLI + console verb. |
| **Cold-start CLI slugs** | v1.6.2 | Single-shot CLI (`imsg list`, etc.) now shows `name~service~hash` slugs, not raw phone/email ids. Slugs are computed + persisted **synchronously** for the returned page in `list_conversations`/`findChatByHandle` (was: background sync didn't persist before the process exited). Agent/MCP path was always unaffected. |
| **Cloud-transcription escape-hatch** | v1.7.0 | `get_attachment` audio: opt-in OpenAI-compatible cloud fallback via `IMSG_TRANSCRIBE_PROVIDER` + `IMSG_TRANSCRIBE_API_KEY` (+ optional `IMSG_TRANSCRIBE_MODEL`, default `whisper-1`). Local transcribers (`hear`/`yap`/`whisper-cli`) always win; cloud runs only when configured **and** local produced nothing. Audio leaves the device only on explicit opt-in; result surfaces `transcriptSource: "local"｜"cloud"`. |
| **Per-thread info / attachment drawer** | v1.8.0 | TUI **`i`** opens a side-column drawer: thread metadata (name, slug, service, group/direct, participant count, message count, first→last range) + a browsable list of **all** attachments across the merged legs (stickers/plugin UTIs excluded). Drawer keys: `j/k` select · `o` open (Quick Look / mpv) · `s` save to `~/Downloads` · `y` copy path · `a` export all to `~/Downloads/imsg-<slug>/` · `Esc/q` close. |
| **Analytics on CLI + console** | v1.4.1 | All 7 analytic types via `imsg analytics <type> [days] [--json\|--yaml]` (alias `imsg stats`) + console `analytics` verb (was leaderboard-only outside the TUI). Shared renderer with ASCII heatmap + phone-safe YAML. |
| **Core-seam cleanup** | v1.8.0 prep | Moved the only two core→frontend edges into core: `src/export-formats.ts` (was `tui/exportFormats.ts`, used by `exportStream.ts`) and `src/date-parse.ts` (was `tui/dateParse.ts`, used by `index.ts`). Future-proofs the deferred migration. |

### Shipped in the Media-Intel cycle (v1.9.0 → v1.15.0)

Architecture rule for the whole cycle: **all processing lives in core (`src/`); frontends only
render.** New core modules: `media-intel.ts` (service), `media-intel-cache.ts` (SQLite at
`~/.imsg-mcp/media-intel.db`), `media-providers.ts` (OpenAI-compatible client + presets),
`app-config.ts` (wider config schema, absorbs `tui-config.ts`), `edit-history.ts`,
`attachment-sync.ts`, `setup-wizard.ts`.

| Feature | Release | Notes |
|---|---|---|
| **Apple-native media text** | v1.9.0 | Reads `IMAudioTranscription` out of `attributedBody` typedstream attributes (iPhone-synced voice-note transcripts → `Message.appleAudioTranscript`); surfaces Genmoji `emoji_image_short_description` → `Attachment.emojiDescription`; reply-context kind fix → `ReplyContext.replyToKind` (`voice-note`/`image`/`video`/`file`) so a reply to a voice note reads "↩ voice note: '…'" instead of "(unknown)". Zero network. |
| **Media-intel core** | v1.10.0 | Provider-agnostic interpretation service + permanent cache. Per-media-type **chains** (`apple` → `local` → `provider:<name>`), OpenAI-compatible client (2 shapes: `/audio/transcriptions` multipart + `/chat/completions` multimodal), concurrency limiter + in-flight dedupe, video pipeline (poster + optional sparse `ffmpeg` frames + `avconvert` audio-track transcript). Results cached forever — never interprets the same media twice. |
| **Edit history** | v1.11.0 | Parses `message.message_summary_info` bplist (`"ec"` prior versions, `"rp"` retracted) → `Message.editHistory`; TUI drawer shows the "Edited N times" timeline. |
| **Setup wizard** | v1.12.0 | `imsg setup --interactive` (`@inquirer/prompts`): doctor probe + `brew install` one-liners, add/edit provider profiles (preset or custom base URL, masked key paste, Cloudflare account id), per-media chain ordering, toggles. Config in `config.json`; keys in `~/.imsg-mcp/credentials.json` (chmod 600). |
| **Surfaces everywhere** | v1.13.0 | `get_attachment.interpret`, `export_messages.interpret` (+ paid-call guard), `get_messages` inline `[voice note: "…"]` (cached/instant only — never blocks reads on cloud), `imsg interpret <rowId> [--force]` CLI, TUI interpret states + `R` retry + `f` reveal-in-Finder. |
| **TUI settings panel** | v1.14.0 | Mode `"settings"` via `,` (and the palette): view/reorder chains, toggle auto-mode/inline/threshold/nudge, provider list with key-present indicators (no key entry in the TUI — wizard/file only). |
| **Attachment sync nudge** | v1.15.0 | `ensureAttachmentDownloaded` (`src/attachment-sync.ts`): **T1** (default) opens the conversation (`imessage://`) + polls; **T2** (opt-in, new **Accessibility** permission) UI-scripts "Sync Now". Wired into `get_attachment`, TUI open/save, and `imsg export --include-attachments`. **T3** documented only (see backlog). |

**Media-intel config** lives under `interpret` in `config.json`: `auto` (`all`｜`free`｜`off`, default
**`free`**), `inlineTranscripts`, `exportConfirmThreshold` (default 25), `chains`, `providers[]`,
`nudge {enabled, tier2SyncNow, timeoutSeconds}`. Cloud calls happen **only** per the configured
chain/auto-mode — audio/images leave the device solely on explicit opt-in, never by default.

**Analytics:** 7 of 27 enum types are implemented (`IMPLEMENTED_TYPES` in `src/analytics.ts`);
the other 20 return a friendly schema error until built (see Backlog §1).

---

## Carry-forward gotchas / ops notes

Durable facts that repeatedly bite — keep these in mind before touching the relevant area.

- **1Password SSH signing re-locks after a timeout.** Needs a periodic user unlock; **never skip
  signing** (no `--no-gpg-sign`). Pattern when it's locked mid-flow: save the commit message to a
  scratch file and background-retry `git commit -F msgfile` until it succeeds.
- **`gh` CLI intermittently auth-times-out** on the macOS keychain (`gh pr create`/`checks`/`merge`).
  `git push` uses a different credential and keeps working. Fallbacks that need neither the keychain
  nor local signing: read CI via the **public** REST API (`commits/{sha}/check-runs`, unauthenticated
  works for public repos); merge server-side via `PUT /repos/{owner}/{repo}/pulls/{n}/merge` with
  `$GH_TOKEN` + curl. It usually recovers — a patient background retry beats foreground spinning.
- **Release serialization.** `@anolilab/multi-semantic-release` (per-package; `pnpm release`)
  triggers on push to `main`; `concurrency` serializes runs but checkout uses the triggering SHA — so
  **back-to-back merges risk a non-ff push failure**.
  Merge one PR, wait for its release run to complete, then merge the next. Merge (**not** squash) so
  commit types drive versioning (`fix`=patch, `feat`=minor, `chore`/`refactor`=no bump).
- **CI gates.** `build-test` (macOS) is the real merge gate. `verify` / `screenshots-check` are
  `continue-on-error` / report-only — **not** gates.
- **Global `imsg` is a live symlink.** `pnpm add -g "$(pwd)"` symlinks `node_modules/imsg-mcp` → the
  repo, so `pnpm build` reflects in the global binary instantly. Re-link after any repo move.
- **Fixtures are synthetic and anchored to 2025-01-01.** "Now" has drifted past, so short analytic
  windows (90/365d) read 0 in fixture tests — use `1825`. Fixtures are gitignored (NOT Git LFS);
  `pnpm fixtures` regenerates them. Never test the TUI against the real `~/Library/Messages/chat.db`
  — point it at `fixtures/chat.db` + a fresh `VITE_SLUGS_DB_PATH`.
- ~~Vitest is v2~~ **stale — the monorepo migration landed Vitest 3.2.7** (kept for history; no skew remains).
- **Real dev DB shape** (`~/Library/Messages/chat.db`, ~403k messages): scheduled-message columns
  exist but have **0 rows** (that path is unprovable here — deferred); `date_retracted` is 0 across
  the whole DB; `person_centric_id` is NULL on the dev chat.db, so cross-source merge leans on the
  Address Book `contactId` signal (see [`CONTACT_MERGE_AND_SLUGS.md`](../apps/imsg-mcp/docs/CONTACT_MERGE_AND_SLUGS.md)).

---

## Backlog

Ordered roughly by priority. Nothing here blocks the current release.

### 1. Analytics — 20 remaining types (P2)
`chat_analytics` ships 7 types; the enum reserves 20 more (`FUTURE_TYPES` in `src/analytics.ts`),
which return a friendly schema error until implemented. Each is a pure
`(messages: Message[]) => Result` added to `dispatchAnalytic` + `IMPLEMENTED_TYPES` + `ANALYTIC_INFO`
(the cache layer is type-agnostic). Aim for ~5-per-PR. Reserved: `silences`, `ghost_storms`,
`conversation_half_life`, `sent_received_imbalance`, `tapback_per_person`, `read_receipt_latency`,
`most_used_words`, `emoji_leaderboard`, `attachment_volume`, `media_share_breakdown`,
`group_chat_activity`, `chat_age_distribution`, `first_messages_log`, `last_messages_log`,
`quietest_chats`, `loudest_chats`, `weekend_vs_weekday`, `night_owl_score`, `most_edited_messages`,
`retraction_rate`.

### 2. Tech-debt: god-file decomposition — deep splits (P2, needs greenlight)
The **safe pass shipped** (A5, PRs #27–#30, 2026-07-21, all zero-behavior-change):
all 22 `@ts-expect-error` in mcp-tools.ts replaced by one documented `toOutputSchema()` cast;
schemas → `src/mcp-schemas.ts` (re-exported, import surface unchanged); pure formatters →
`src/mcp-format.ts`; TUI attachment actions → `src/tui/attachmentActions.ts`; pure
conversation-merge cascade → `src/conversation-merge.ts` **with first direct unit tests**
(`tests/conversation-merge.test.ts`). New line counts: imessage-db ~2480, index ~1840,
App.tsx ~1180, mcp-tools ~520.

**Remaining (deeper, opinionated — separate greenlight each, one PR per split, full test runs):**
- `src/index.ts` handler-body grouping: split the 22-case switch's handler bodies into domain
  modules (message/contact/attachment/analytics handlers) taking a context object.
- `src/tui/App.tsx` input-router → a `useInputRouter` hook (or fuller keymap.ts adoption).
- Deeper `src/imessage-db.ts` splits: SlugManager / AttachmentRepo-style delegates for the
  stateful clusters (slug sync, snippet resolvers, attachment queries).

### 3. tsconfig strict flags (P2, internal)
Enable one at a time; fix call sites with `?.` / guards, not `@ts-expect-error`.
`noUncheckedIndexedAccess` (~77 errors) and `exactOptionalPropertyTypes` (~18).
`noImplicitOverride` + `verbatimModuleSyntax` already on.

### 4. Stress harness → CI wiring — **DONE 2026-08-10 (PR #68)**
`stress-mcp --report <path>` emits a JSON artifact; CI runs it on macOS and on a new
`stress-linux` job (`IMSG_DISABLE_NATIVE=1` TS fallback, synthetic fixtures, no LFS); pack-size
guard (`scripts/check-pack-size.mjs`, threshold 2.3 MB) and README tool-table drift guard
(`scripts/check-readme-tools.mjs`) gate the macOS job. Drive-by: the harness spawns the server
with `IMSG_DEV=1` (`health_check` is dev-gated — without it check 5b#6 always failed).

### 5. Account diagnostics via AppleScript (P2)
`listAccounts()` → surface `connection_status` / `service_type` / `enabled` per account in
`health_check` (so the agent can say "iMessage is disconnected; sends will fall back to SMS").
Optional `listFileTransfers()` as a TUI progress widget. Patterns are compile-checked in
[`applescript-examples.md`](../apps/imsg-mcp/docs/applescript-examples.md); wiring is straight `runAppleScript()` wrappers.

### 6. Wrap `structuredContent` message bodies in `wrapUntrusted` (P2)
`wrapUntrusted` is applied only to the human-readable `content[0].text`, not to
`structuredContent.messages[i].text`. Hosts that pipe `structuredContent` straight into a prompt are
still exposed. Thread it through `messageToStructured` behind an opt-in flag. See
[`GUARDRAILS_MCP_RESPONSES.md`](../apps/imsg-mcp/docs/GUARDRAILS_MCP_RESPONSES.md).

### 6b. Parked decisions / small guards (P3)
- **`pack:mcpb` CI guard**: exercise the `.mcpb` staging build in CI so release-time landmines (the
  `workspace:*` npm-install class from #64, the `rm -rf release` class from #69 — both caught only
  AT release) surface pre-merge. Idea survived only in memory notes until now.
- **Git-history scrub of the pre-#57 real-message fragments** (public repo): #57 fixed forward with
  synthetic fixtures; the ORIGINALS remain in git history. Rewriting is a deliberate George-owned
  decision (force-push of signed history) — parked here so it can't silently expire.

### 7. Lower-priority (P3)
- **Streamable-HTTP transport** — stdio-only today; add the template's HTTP transport (constant-time
  bearer auth, 127.0.0.1 bind, `MAX_BODY_BYTES`, `/health`) for remote inspection/dashboards.
- **Shell completions via `usage`** — a `.usage.kdl` spec driving bash/zsh/fish + a manpage, with a
  CI drift check. Today we rely on commander's `--help`.
- **`contact:N` cross-session persistence** — the disambiguation LRU is process-wide and resets on
  restart; persist to `~/.imsg-mcp/contact-resolver.db` (TTL ~1 day) + a `forgetContactSelector()`.

### 8. Media-Intel follow-ups (P2/P3)
Cycle shipped v1.9.0 → v1.15.0; these are the deliberately-out-of-scope tails.
- **Analytics over interpreted media (P3)** — now that transcripts/captions are cached, media-aware
  analytic types (e.g. `media_share_breakdown`, `most_used_words` incl. voice) become cheap. Folds
  into Backlog §1.
- **Attachment sync — T3 bulk download (P3, documented only)** — the conversation-info pane has a
  per-thread "download all attachments" affordance; UI-scriptable but brittle across macOS versions.
  Not shipped; keep as researched-only. The addressable set is tiny on a fully-synced Full-Disk-Access
  Mac (Stage 7 live test: server-purged media is unrecoverable by any client).
- **Private-API / SIP attachment-download route — NO-GO (closed)** — spike concluded against it:
  BlueBubbles' IMCore hooks expose no attachment-download method, and the injection route needs full
  `csrutil disable` + system-wide Library Validation off (heavier than yabai's partial SIP). Full
  rationale + revisit triggers in
  [`docs/plans/media-intel/spike-sip-findings.md`](../apps/imsg-mcp/docs/plans/media-intel/spike-sip-findings.md). Revisit
  only if Apple ships a public download API or prior art adds a battle-tested re-download hook.

### 8b. TUI reliability — open findings from the swarm stress-drive (P1/P2)
Method + shipped fixes: 2026-08-10 HANDOFF entry. Full consolidated record (method, all eight
shipped fixes with evidence, clean verdicts, process lessons):
[`../docs/agent-handoff/ITER14-SWARM-FINDINGS.md`](../docs/agent-handoff/ITER14-SWARM-FINDINGS.md)
— untracked, since it cites real thread slugs. Everything below was OBSERVED against the real DB,
not theorised.

- ~~**~3s blank boot with no indicator (P1)**~~ **done 2026-08-16 (PRs #88 + #90, v1.21.5/1.21.7).**
  Two separate causes, both measured by capturing the tmux pane every 100ms (A/B/A against the same
  build to rule out page-cache warmth):
  1. *Nothing painted.* `better-sqlite3` is synchronous, so the mount effect's DB work blocked the
     event loop and starved Ink's first flush — **blank 1867–3938ms, first paint 4074ms**. The
     initial load is now deferred one macrotask so frame one reaches the terminal first. That
     exposed something worse than blank: the boot frame said *"No conversations"* / *"No messages"*
     on an account with thousands of both, so `Sidebar`/`ThreadPane` gained a `loading` prop and
     `StatusBar` now prefers the caller's specific status over its hardcoded `"loading..."`.
  2. *It was genuinely slow.* `getLastMessageByChat` was `ROW_NUMBER() OVER (PARTITION BY chat_id
     ORDER BY date DESC)` — it numbered **every message in the database** (408k) to keep one per
     chat; plan was a full `SCAN m` plus `USE TEMP B-TREE FOR ORDER BY`. Replaced with a `MAX(date)`
     aggregate (SQLite's bare-column rule returns the whole extreme row in one indexed pass):
     **1213ms → 342ms**, verified equivalent on the real DB first (0 date mismatches, 0 ties
     resolved differently). `listConversations` 1808ms → 714ms.
  Net, end-to-end on a real account: **indicator at 2.1s, data at 3.2s** (was blank until 3.9s,
  data ~4.3s). Also benchmarked and deliberately NOT changed: `getAllChatsWithLastDate`'s correlated
  subquery measured 328ms vs 356ms for a grouped LEFT JOIN — inside the noise.
- **Drawer polish (P2, partially done).** ~~Group participants never itemised; a 1-on-1 thread
  rendered "People: Shara, Shara"~~ **done 2026-08-16 (PR #89)** — names are deduped by identity
  (merged legs repeat the same person) and groups now name people instead of showing a bare count.
  Still open: edit-history header row breaks the drawer's right border; reaction attribution shows a
  raw handle instead of the resolved contact name; unnamed groups display raw `chat9262…`
  identifiers; `y` copies to the clipboard with no visual confirmation.
- ~~**Filter-Esc leaves a stale thread pane (P2)**~~ **done 2026-08-16 (PR #89).** `UPDATE_FILTER`
  snaps `selectedIdx` to 0 on every keystroke, and `EXIT_FILTER` left that behind and loaded
  nothing — so cancelling a filter landed on conversation #0 with the previous thread's messages
  under its name. Escape now restores the pre-filter index and scroll; Enter keeps its committed
  selection, distinguished by an explicit `restoreSelection` flag rather than by accident.
- ~~**Observability gaps found by A5 (P3)**~~ **done 2026-08-16 (PR #91).** The startup line now
  carries `engine`; the shutdown marker reports the recorded cause (`signal:SIGTERM`,
  `watchdog:rss_exceeded`, `stdin_eof`, …) instead of a hardcoded `"normal"` for every exit; and
  `readWatchdogState()` fills `rssMb`/`heapMb` from a live reading until the 60s sampler first
  fires, so a just-started process no longer reports 0MB.
- **Eviction path unverified (P2).** The 5000-message hard cap's "N older messages evicted"
  placeholder was never reached through any real UI path during the drive — worth a targeted test
  now that the pagination and leak bugs that blocked reaching it are fixed.
- **Date picker only accepts arrow keys (P3)** — `hjkl` does nothing there, and an unparseable
  free-text date is silently refused with no error shown.

### 8c. MCP correctness — `get_messages` pagination silently skipped history
**Found + fixed 2026-08-16 (PR #87, v1.21.4).** Not a swarm finding: spotted while reading
`useImsg.ts` for the boot work, from a stale `minMessageId` import.

`get_messages` advertises `oldestMessageId` and the docs tell agents to feed it back as
`beforeMessageId`. It was the **minimum ROWID**, but `getMessagesForChat` resolves that id to the
message's **date** and pages on the composite `(date, ROWID)`. In merged threads (phone + email,
SMS + iMessage) those orders diverge, so the advertised cursor pointed at a message *newer* than the
page's true oldest and everything between was skipped — silently, every page turn, with `hasMore`
still true.

Measured on the real DB: **6 of 35 full-page threads diverged**, worst cases skipping 193 / 147 / 87
messages in a SINGLE page turn with the cursor date jumping forward two to three years.

**The lesson worth keeping:** this was the same defect as the TUI false-exhaustion fix (#253), which
introduced `oldestMessageCursor()` but migrated only its own call site and left `minMessageId`
exported for three others. `minMessageId` is now **deleted** — a fix that adds a correct helper and
leaves the broken one available is a fix that will be half-applied.

### 9. Real-time streaming, memory scroll & Messages API-surface (P1–P3)
Full design + audit: [`plans/realtime-streaming-and-api-surface.md`](../apps/imsg-mcp/docs/plans/realtime-streaming-and-api-surface.md).
- ~~Cache-hit metrics~~ **done 2026-08-09 (PR #65, v1.20.0)** — `hits/misses/evictions` in
  `cacheStats()`, dev-stats row, `cache_hit_rate` perf line on the 60s sweep, incremental
  `messagesByGuid` in ThreadPane. Remaining P2 tail: the rendered Ink tree itself is windowed but
  not formally virtualized (render visible+overscan only).
- ~~Core `ChangeWatcher` → EventBus + all three frontends~~ **done 2026-08-09/10 (PRs #66/#70/#72,
  v1.21.0; hardened in v1.21.1 — see below)** — WAL-dir fs.watch (debounced, poll fallback, high-water ROWID, paged drain) →
  typed `EventBus` (`message.new` | `reaction`; edited/unsent/group.* variants reserved); TUI
  streams live via `useSyncExternalStore` (active-chat append + sidebar patch, `r` kept as
  fallback), console gained a bounded `watch` verb, MCP gained long-poll `wait_for_changes`,
  and `wait_for_reply` now wakes on bus events (authoritative read + echo suppression unchanged;
  `pollIntervalSeconds` is the fallback cadence). Remaining: live latency verify on a real
  incoming text (George), and emitting the reserved event variants (below).
- **WAL-watch lesson (2026-08-10, v1.21.1):** an `fs.watch` on the DIRECTORY containing
  `chat.db` arms cleanly but macOS **never delivers events** for the TCC-protected
  `~/Library/Messages` — live streaming was blind on every real Mac while passing every temp-dir
  integration test. The watcher now also kqueue-watches `chat.db-wal` itself (re-armed via
  directory entry events across checkpoints) plus an always-on 10s safety poll. Any future
  detection work must keep a primitive that doesn't depend on directory-event delivery.
- **Group joins / leaves / renames (P2) — real GAP.** `isHiddenSystemItem(item_type!=0)` filters all
  group-action rows out everywhere. Decode into a typed `ConversationEvent` (member_added/removed,
  renamed) via a dedicated path (keeps default `item_type=0` message queries + analytics unaffected).
- **Rust parser hygiene (P2 privacy / P3 unify).** `native/src/attributed_body.rs` is the persisted
  "simplified initial implementation" (comment: *"A full typedstream binary parser will be added in a
  later phase"*) while TS has a structured `TypedStreamParser` — two strategies for one job.
  ~~Scrub real-message-derived example fragments from its comments~~ **done 2026-08-09** (synthetic
  same-length fixtures; originals remain in git history only); later, port Rust to the structured
  algorithm + differential test (`native == TS`), then delete the heuristic path.
- **P3 tails** — derived `serviceConfidence` heuristic so glitchy MMS-vs-iMessage data stays queryable
  under a ruleset (don't drop it); first-class read-receipt indicator + reactive `message.read`;
  explicit `focus_messages`/`activate` affordance (mirrors the reliable `tell Messages to activate`).

### Declined
- **Semantic / vector search** — explicitly declined for v1 (fuzzy `WRatio` + literal `LIKE` cover
  realistic queries). Revisit only on a concrete "describe-the-topic" request.

### Deferred (own doc)
- **Monorepo / turborepo migration** → **ACTIVE / handed off**, see [`../HANDOFF.md`](../HANDOFF.md);
  design in [`MONOREPO_MIGRATION.md`](MONOREPO_MIGRATION.md).

### Deferred ideas (future analytics app — flesh out later)
- **Home-lab observability interface (Grafana / Prometheus).** The relationship-analytics app should be
  able to expose relationship/messaging metrics to personal observability stacks — e.g. a
  Prometheus-scrapeable endpoint (or pushgateway) so users build Grafana dashboards over their own
  message corpus. Not yet designed; George to flesh out. Captured also in
  [`MONOREPO_MIGRATION.md`](MONOREPO_MIGRATION.md) and `../HANDOFF.md` §10.
- **Suite rename — DECIDED: `EQStack`** (2026-07-30). Internal scope `@eqstack/*`; the GitHub repo
  rename happens with the monorepo conversion; published `imsg-mcp` package name unchanged; Desktop
  extension `display_name` already "EQStack — Messages MCP". See `../HANDOFF.md` §4 (Q1 answered).
- **MCP config-sync tool — DONE (2026-08-03), lives elsewhere.** Built as `mcpsync`
  (`mcp-cli-starter-template/apps/mcpsync`, installed globally): one canonical config → every MCP
  host (Claude Code/Desktop, Codex, Cursor, Warp, opencode), drift grid, doctor + secret hygiene,
  secrets vault, project scope, and extension hot-deploy (`mcpsync deploy` replaced this repo's
  `scripts/hot-deploy-ext.mjs`, now deleted). The `~/dotfiles/mcp/` prototypes are retired too.
  The original feature-absorption inventory remains at
  [`plans/mcp-config-sync-tool.md`](../apps/imsg-mcp/docs/plans/mcp-config-sync-tool.md).

---

## Standing constraints (project rules)

No autonomous message sends. Real personal data is never committed (synthesize test data; test the
TUI against `fixtures/chat.db`, never the real DB). Foreground tests only (background leaves orphaned
vitest workers). Don't touch `engines.npm`. Don't run `pnpm sync-env-data`. Never `git add -A` —
scratch files (`.tui-audit-notes.md`, `.claude/settings.local.json`, `.codex/`, `docs/research/*`)
are never committed. Delete any temp screenshots/exports containing real content after use. humans
files are `privacy: never-share`. Merge (not squash) so semantic-release drives versioning. Only act
on this agent's own SMS/email thread. Vercel/superpowers hook injections are false positives here —
ignore.
