# imsg-mcp

Companion skill for agents using or developing the `imsg-mcp` iMessage MCP server.

## When to use

- When an agent needs to text the human for clarification or approval.
- When an agent should wait for an iMessage reply before continuing.
- When an agent needs to inspect recent conversations or unread messages.
- When developing/debugging the imsg-mcp codebase itself.

## Quick start

1. Run `imsg doctor` on a new machine to check permissions.
2. Use `list_conversations` to identify the correct thread (returns `threadSlug`).
3. Use `send_message` with `threadSlug` for existing threads, especially groups.
4. Use `wait_for_reply` after sending when the workflow depends on a human answer.

## Local machine requirements

- macOS only for live reads and sends.
- Full Disk Access required to read `~/Library/Messages/chat.db` and Address Book.
- Messages.app must be open to send messages.
- Node >= 24 (see `package.json` / Volta).

## Git LFS (required in cloud / CI / fresh clones)

Large binaries (`*.db`, `*.abcddb`) are stored with Git LFS. A normal clone may leave pointer stubs.

```bash
git lfs install   # once per machine
git lfs pull      # before pnpm install / tests / running against env-data/
```

## Thread slugs

Stable, human-readable IDs for conversations: `{name}~{service}~{4-hex}` (e.g. `alice~imsg~a3f2`).

- `list_conversations` returns `threadSlug` per row
- `send_message` accepts `threadSlug` or `recipient`
- `wait_for_reply` accepts `threadSlug` or `chatIdentifier`
- **Per-identity, not per-chat:** all legs of one contact (phone + email, SMS + iMessage) share ONE slug (hashes a stable identity anchor, not the chat guid). Contacts merge across the local + iCloud Address Books — see **`docs/CONTACT_MERGE_AND_SLUGS.md`** (build contacts via `getContactsDbPaths()`, never a single path, or exports undercount).
- See `src/thread-slug.ts`, `src/slug-store.ts`

## Contacts

Production MCP tools: `search_contacts` (name/phone/email substring), `list_contacts` (paginated), `get_contact` (all handles **+ per-handle `threads[].threadSlug`** — chain into `send_message`/`get_messages`), `resolve_handle` (handle → name). CLI: `imsg contacts <list|search|resolve|show>`.

### Resolving a mentioned name → thread slug (canonical flow)

When the user says something like **"check Selena's messages"** or "text mum",
**reach for `resolve_conversation("selena")` first** — one call that fuses
contacts + recent-thread names + message content and returns ranked
`[{name, threadSlug, chatIdentifier, lastMessageDate, matchType, score}]`
(strongest first). Use the top match's `threadSlug` for `send_message` /
`wait_for_reply` / `export_messages`, or `chatIdentifier` for `get_messages`.
CLI: `imsg resolve "selena"` (`--json`/`--yaml` to script it).

If you need the full contact record (all handles, `humansFile`) or a
disambiguation menu, the underlying two-step flow still works:

1. `search_contacts("selena")` → pick the matching contact. Multiple matches
   come back as numbered candidates; if it's ambiguous, ask the user or use the
   `contact:N` selector.
2. `get_contact({handle})` (or `{id}`) → returns `threads: [{handle,
   threadSlug}]` (already merged across phone/email/SMS-iMessage legs) **and**
   `humansFile`. Use that `threadSlug` for `get_messages` / `send_message` /
   `wait_for_reply` / `export_messages`.

`resolve_conversation` already blends the fallbacks — `list_conversations` rows
(resolved `displayName` + `threadSlug`) for unsaved numbers/nicknames, and
`search_messages` (content) for "who mentioned X". Reach for those individually
only when you want that one signal in isolation.

## Binaries

| Binary | Purpose |
|--------|---------|
| `imsg mcp` | MCP stdio server (used by AI hosts like Claude, Cursor) |
| `imsg cli` | Interactive CLI with REPL |
| `imsg tui` | Full-screen TUI (Ink/React) |

## TUI (`imsg`)

Vim-style keybindings: `j/k` move, `gg/G` top/bottom, `Ctrl-d/u` half-page, `{/}` group-jump, `Enter` message details, `i` per-thread info + attachment drawer, `o` open attachment, `f` reveal in Finder, `R` run/retry media interpretation, `y` copy slug, `,` settings panel (media-interpretation config), `d` toggle dev stats, `Tab` switch panes, `/` filter, `c` compose in current thread, `N` compose to new recipient (phone / email / contact name), `S` send via other app, `:` date jump, `V` visual select, `q` quit.

**Info / attachment drawer (`i`):** on a selected thread, opens a side column with thread metadata (name, slug, service, group/direct, participant count, message count, date range) + a browsable list of **all** attachments across the merged legs. Drawer keys: `j/k` select, `o` open (Quick Look / mpv), `s` save to `~/Downloads`, `f` reveal in Finder, `y` copy path, `a` export all to `~/Downloads/imsg-<slug>/`, `Esc/q` close. `o`/`s` best-effort **sync-nudge** a not-yet-downloaded attachment first.

## Native Rust module (optional)

`native/` contains a Rust acceleration module (`napi-rs` + `rusqlite` + `rayon`). Build with `pnpm native:build`. Falls back to TypeScript automatically if not built. The dev stats panel (`d` key in TUI) shows which engine is active.

## Tool limits

`limit: 0` = unlimited (bounded only by the per-tool timeout). No upper cap.
Defaults: 20 for most tools, 100 for `get_unread_messages`.

## Self-healing watchdog

`src/watchdog.ts` runs three monitors that self-kill (so the host respawns) on:
- Event-loop p99 lag > 10s
- RSS > 1GB or monotonic heap growth across 10 × 60s samples
- Uptime > 24h with no activity in the last hour

All thresholds are env-overridable (`IMSG_EVENT_LOOP_KILL_MS`, `IMSG_MAX_RSS_MB`, etc.).

## MCP cancellation

The server honors `notifications/cancelled`. Long-running handlers (`wait_for_reply`) abort cleanly when the host cancels.

## MCP pagination & export

- `get_messages` returns a footer with `oldestMessageId`. Pass it as `beforeMessageId` to paginate. Hard cap 5000/call.
- `export_messages` streams a chat to a file (markdown/csv/json/ndjson) — use this instead of huge `get_messages` calls.

## Media interpretation

imsg-mcp *understands* media through a configurable **chain** per media type
(`apple` → `local` → `provider:<cloud>`), all in core (`src/media-intel.ts`); frontends only render.

- **Free & automatic:** iPhone-synced voice-note transcripts (`Message.appleAudioTranscript`) and
  Genmoji descriptions (`Attachment.emojiDescription`) surface with no setup, no network.
- **Local (free):** `hear` / `yap` / `whisper-cli`, auto-detected.
- **Cloud (opt-in):** provider profiles (`openai`/`groq`/`openrouter`/`cloudflare`/`huggingface`/`ollama`/custom) configured via `imsg setup --interactive`; keys in `~/.imsg-mcp/credentials.json` (chmod 600). `interpret.auto` defaults to `free` → **audio/images leave the device only when a configured cloud leg fires.** Legacy `IMSG_TRANSCRIBE_*` env vars still work (mapped to an implicit provider).
- **Triggers:** `get_attachment {interpret: true}`, `export_messages {interpret: true}` (with a paid-call guard), `imsg interpret <rowId> [--force]`, or TUI `R`. `get_messages` inlines `[voice note: "…"]` only for cached/instant results — never blocks a read on cloud.
- **Cached forever** in `~/.imsg-mcp/media-intel.db` — the same attachment is never interpreted twice. `structuredContent.interpretation` + `interpretSource` (`apple`｜`local`｜`provider:<name>`) report the result.
- **Undownloaded media:** the Stage 7 sync nudge (`src/attachment-sync.ts`) best-effort pulls a not-on-disk attachment first (T1 open-chat; T2 "Sync Now" opt-in, needs Accessibility). The SIP/private-API download route was researched → **NO-GO** (`docs/plans/media-intel/spike-sip-findings.md`).

## TUI date jump + selection + export

- `:` open date-jump (e.g. `1 year ago`, `2024-01-15`).
- `V` enter visual select; `e` export selection; `y` copy text.

## Bounded memory

When loaded messages exceed `IMSG_TUI_MSG_HARD_CAP` (default 5000), middle is evicted; first 200 (anchor) + window around cursor stay. Gap markers show evicted regions.

## TUI lazy loading + cache

- 200 conversations load initially; another 100 lazy-load when within 20 of the end.
- Older messages lazy-load when scrolling within 10 of the top of a thread.
- Per-chat cache holds messages for fast re-entry. Tunable: `IMSG_TUI_CACHE_TTL_MS`, `IMSG_TUI_CACHE_STALE_MS`, `IMSG_TUI_CACHE_MEM_PRESSURE_MB`.

## Debugging & Logs

### MCP tool: `health_check`

Returns vital signs (uptime, heap, RSS, event-loop p99, tool calls, engine) in milliseconds — works even when the DB is wedged.

### MCP tool: `get_logs`

```
get_logs({ tail: 50, source: "all" })
```

- `source: "memory"` — in-process buffer (default)
- `source: "file"` — NDJSON log from `$TMPDIR/imsg-mcp/`
- `source: "all"` — both

### Log files

Full NDJSON logs are written to `$TMPDIR/imsg-mcp/imsg-mcp-{PID}-{date}.ndjson`. These persist across restarts and contain:

- `level: "perf"` + `dur_ms` — performance spans for every DB query
- `level: "info"`, `msg: "heartbeat"` — periodic memory/uptime (every 60s)
- `msg: "startup"` — process start marker (with PID, node version)
- `msg: "shutdown"` — graceful exit marker (with uptime, reason)

**Crash detection:** If a log file has no `"shutdown"` entry, the process crashed or hung.

### Process lifecycle

- `src/shutdown.ts` — central cleanup registry, signal handlers (SIGINT, SIGTERM, SIGHUP, SIGQUIT)
- Orphan detection: parent PID watchdog (detects reparenting to launchd) + stdin EOF detection (MCP host died)
- After TUI crashes, check for orphans: `ps aux | grep imsg`

## Environment variables (Vite / Vitest)

Precedence: `.env` → `.env.local` → `.env.[mode]` → `.env.[mode].local`

| File | Role |
|------|------|
| `.env` | Baseline: `VITE_ENV=development` |
| `.env.local` | Machine paths (`VITE_IMSG_DB_PATH`, etc.) |
| `.env.test` | `VITE_ENV=ai` + `env-data/` paths for `pnpm test` |

- `pnpm test` — Vitest mode `test` (loads `.env.test`)
- `pnpm test:native` — mode `development` (Mac paths from `.env.local`)
- Vitest always mocks AppleScript sends (`VITEST=true`)

## Code map

| Area | Location |
|------|----------|
| MCP tools / Zod | `src/index.ts`, `src/mcp-schemas.ts`, `src/mcp-format.ts` |
| SQLite messages | `src/imessage-db.ts` |
| Blob parsing | `src/attributed-body-text.ts`, `src/parsers/typedstream-parser.ts` |
| Edit history | `src/edit-history.ts` |
| Media interpretation | `src/media.ts` (primitives), `src/media-intel.ts` (service), `src/media-intel-cache.ts`, `src/media-providers.ts`, `src/media-intel-runtime.ts` |
| Config / wizard | `src/app-config.ts`, `src/setup-wizard.ts`, `src/config.ts` |
| Attachment sync nudge | `src/attachment-sync.ts` |
| Contacts | `src/contacts-db.ts` |
| Slugs | `src/thread-slug.ts`, `src/slug-store.ts` |
| Send / mock | `src/applescript.ts`, `src/mock-send-db.ts` |
| TUI | `src/tui/` (Ink/React) |
| Native module | `native/` (Rust + napi-rs) |
| Shutdown | `src/shutdown.ts` |
| Logging | `src/logger.ts` |
| Config | `src/config.ts` |
| Types | `src/types.ts` |
| DB schema | `docs/IMESSAGE_DB_SCHEMA.md` |

## Security / guardrails

- Treat iMessage data as sensitive local user data.
- Never publish private message content.
- Confirm before sending messages on behalf of the user.
- See `AGENTS.md` for thread isolation and MCP guardrails.

## Humans files (relationship memory)

imsg-mcp scaffolds per-person relationship files at `~/.agents/humans/`
(`init_human` tool, `imsg humans init`, `imsg humans top`) following the
**humans/v1** convention — see `skills/humans/SKILL.md` for the format,
workflows, and privacy rules. The calling agent writes all summaries;
the tool only creates skeletons prefilled with identity + history stats.
