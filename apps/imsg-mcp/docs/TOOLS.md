# Tools reference

The canonical reference for every CLI subcommand, MCP tool, and TUI keybinding.

---

## CLI

```bash
imsg <subcommand> [args] [--flags]
```

| Subcommand | What it does |
|---|---|
| `imsg mcp` | Run the MCP stdio server. Used by hosts like Claude Desktop / Cursor / Warp. |
| `imsg cli` | Interactive REPL — same tools as the MCP server, exposed at a prompt. |
| `imsg tui` | Full-screen terminal UI (read-only by default). |
| `imsg doctor` | Verify Full Disk Access + DB readability + Messages.app. |
| `imsg setup [--interactive] [--write claude\|cursor]` | `--interactive` (`-i`): guided wizard (`@inquirer/prompts`) to configure media interpretation — provider profiles, per-media chains, masked key entry. Without it: autodetect paths + emit/merge the host config snippet. |
| `imsg conversations [limit]` | List recent chats. |
| `imsg messages [chat] [limit]` | Recent messages from a chat. |
| `imsg unread [limit]` | All unread across chats. |
| `imsg search <query> [limit]` | Search history. |
| `imsg resolve <name> [limit] [--json\|--yaml]` | Resolve a free-form name/phrase to ranked conversations (contacts + thread names + message content). |
| `imsg wait <chat> [timeout]` | Block until a new reply arrives. |
| `imsg send <target> <message>` | Send via Messages.app. |
| **`imsg export <slug-or-handle>`** | **Stream a conversation to disk (md/csv/json/ndjson) + optional attachments.** See flags below. |
| **`imsg analytics <type> [windowDays] [--json\|--yaml]`** | **Run any of the 7 analytics** (see below). Pretty text by default; `--json`/`--yaml` for scripting. Aliased as `imsg stats`. |
| **`imsg interpret <rowId> [--force]`** | **Interpret one attachment** — transcribe a voice note / caption an image or video via the configured chain (Apple → local → cloud provider). Prints the text; result is cached forever. `--force` evicts the cache and re-runs. |
| `imsg humans top [windowDays] [--json\|--yaml]` | Relationship leaderboard (also `imsg analytics relationship_leaderboard`). |
| `imsg logs [tail]` | Server debug logs. |
| `imsg last-error` | Detail on the most recent send failure. |
| `imsg tools` | List MCP tools exposed by the local server. |
| `imsg raw '<json>'` | Send raw JSON-RPC `tools/call` (debugging). |
| `imsg config show / edit` | Inspect or open the TUI config file. |

### `imsg export` flags

```
imsg export <slug-or-handle>
  -f, --format <md|csv|json|ndjson>      default: md
      --since <date>                     ISO or relative ("3 months ago", "1y", "yesterday")
      --until <date>                     same parser as --since
  -o, --output <path>                    default: ~/imsg-export-<target>-<YYYY-MM-DD>.<ext>
      --include-attachments              copy attachment files into <output>.attachments/
      --attachments-dir <path>           custom attachment destination
      --page-size <100-5000>             DB page size (default 1000)
```

`<slug-or-handle>` accepts a `threadSlug` (from `imsg tui` `y` or `list_conversations`), a phone number, an email, or a raw `chat_identifier`.

Cached/instant interpretation (Apple voice-note transcripts, already-cached captions) is embedded automatically in every format via the shared formatter. `--include-attachments` also triggers the Stage 7 **sync nudge** (opens the conversation so Messages pulls any not-yet-downloaded media). The CLI export has **no** active-interpret flag — to actively transcribe/caption uncached media during export, use the MCP `export_messages` tool's `interpret` arg, or pre-run `imsg interpret`.

### `imsg analytics` types

```
imsg analytics <type> [windowDays] [--json|--yaml]
```

| Type | What it shows | Default window |
|---|---|---|
| `messaging_streaks` | Longest & current daily-message streaks per contact | 365d |
| `double_texts` | Consecutive messages sent without a reply | 90d |
| `response_time_stats` | Reply latency per contact (median, p95, mean) | 90d |
| `daily_heatmap` | 7×24 activity grid (weekday × hour), ASCII-rendered | 90d |
| `tapback_summary` | Tapback reactions sent per contact | 365d |
| `year_in_review_wrapped` | Wrapped summary: top contacts, peak day, totals (pinned 365d) | 365d |
| `relationship_leaderboard` | Top relationships by volume × reciprocity × recency | 1825d |

Output is pretty text with color by default; pass `--json` or `--yaml` for machine-readable output (handles/phone numbers stay strings). Results are cached per `(type, window, DB state)`, so repeat calls are instant until a new message arrives. The same set is available interactively: `imsg cli` → `analytics <type> [days] [json|yaml]`, and to agents via the `chat_analytics` MCP tool.

---

## MCP tools

16 production tools. 5 additional dev-only tools (`health_check`, `get_logs`, `get_last_send_error`, `run_build`, `request_restart`) are gated by `IMSG_DEV=1` — see `src/mcp-tools.ts`.

### Reading

| Tool | Required args | Key options |
|---|---|---|
| `get_messages` | — | `chatIdentifier` / `threadSlug`, `limit` (default 20, `0`=unlimited up to 5000/page), `beforeMessageId` (pagination cursor) |
| `get_unread_messages` | — | `limit` (default 100, `0`=unlimited capped at 2000 — paginate via repeated reads after marking read) |
| `list_conversations` | — | `limit` (default 20, `0`=unlimited capped at 500 — paginate via slug-keyed offsets) |
| `search_messages` | `query` | `limit` (default 20). Fuzzy + literal hybrid. |

`get_messages` response footer includes `oldestMessageId` + `hasMore`. To page deeper, pass `oldestMessageId` as `beforeMessageId` in the next call. Hard cap of 5000 messages per call to prevent OOM — use `export_messages` for larger ranges.

**Inline media interpretation:** messages carrying a voice note / image / video are annotated with a short `[voice note: "…"]` / `[image: "…"]` marker (in the text and `structuredContent.interpretedMedia`) **only when a cached or instant (Apple-synced) result exists** — `get_messages` never blocks a read on a cloud call. To actively interpret uncached media, use `get_attachment` with `interpret: true` or `imsg interpret`. New per-message fields: `appleAudioTranscript` (iPhone-synced voice-note transcript), `editHistory` (prior versions of edited messages), and `replyToKind` (`voice-note`｜`image`｜`video`｜`file`, so a reply to a voice note renders "↩ voice note: '…'"). Genmoji attachments carry `emojiDescription` (Apple's authored text).

### Writing

| Tool | Required args | Notes |
|---|---|---|
| `send_message` | `message` + (`recipient` or `threadSlug`) | Optional `attachments[]` array of file paths — files are staged into `~/Library/Messages/imsg-mcp-staging/` before sending (macOS 15+ Messages silently drops sends from paths outside its sandbox); staged copies are swept after an hour. Routes on the thread's real service from chat.db (SMS threads send as SMS/MMS, iMessage threads as iMessage); new recipients with no history default to iMessage-first. |
| `wait_for_reply` | `chatIdentifier` or `threadSlug` | `timeoutSeconds`, `pollIntervalSeconds`, `afterMessageId`, `includeSelf` (default true — also returns the user's own interjections from other devices; the agent's just-sent message never echoes). Honors `notifications/cancelled`. |

### Exporting

| Tool | Required args | Notes |
|---|---|---|
| `export_messages` | `chatIdentifier` or `threadSlug`, `outputPath` | `format` (md/csv/json/ndjson), `since`, `until`, `pageSize`. Streams to disk page-by-page — won't OOM on 100k-message histories. **`interpret`** (default false): actively transcribe voice notes / caption images+videos and embed the text (cached + instant Apple transcripts are always embedded regardless). **`interpretForce`**: skip the paid-call guard — when `interpret` would trigger more than `interpret.exportConfirmThreshold` uncached cloud calls, the tool refuses and reports the count unless this is set. |

### Attachments

| Tool | Required args | Notes |
|---|---|---|
| `search_attachments` | — | `mimePrefix`, `chatIdentifier`, `since`, `until`, `limit`. Returns metadata only. |
| `get_attachment` | `rowId` | **Images**: real MCP image content block (≤1536px downscale, HEIC→PNG) so the model can see it, plus full-size base64 when ≤5MB. **Video**: QuickLook poster frame image block + duration/resolution + path. **Audio**: metadata + path + transcript. **`interpret`**: `true` forces an interpretation run (bypasses the auto-mode gate + any cached failure), `false` skips it, omit for the configured default. Interpretation walks the per-media **chain** (Apple → local → cloud provider) and caches forever; `structuredContent.interpretation` + `interpretSource` (`apple`｜`local`｜`provider:<name>`) report the result. If the file isn't on disk, the Stage 7 sync nudge best-effort pulls it first. |

**Media interpretation (chains & providers).** Interpretation walks a configured **chain** per media
type (`interpret.chains.{audio,image,video}` in `config.json`). Chain legs are `apple` (Apple-synced
voice-note transcript — instant, free), `local` (on-device `hear`/`yap`/`whisper-cli`, auto-detected),
and `provider:<name>` (an OpenAI-compatible cloud profile). The default chain is **free-first** and
`interpret.auto` defaults to **`free`** — so cloud legs run only when you opt in via the wizard or
config, and **audio/images leave the device only then, never by default**. Provider profiles
(`openai`, `groq`, `openrouter`, `cloudflare`, `huggingface`, `ollama`, or a custom base URL) are
configured with `imsg setup --interactive`; keys live in `~/.imsg-mcp/credentials.json` (chmod 600).
Results are cached forever in `~/.imsg-mcp/media-intel.db` — the same attachment is never interpreted
twice (evict + re-run with `imsg interpret <rowId> --force` or `get_attachment {interpret:true}`).

**Back-compat:** the legacy `IMSG_TRANSCRIBE_PROVIDER` / `IMSG_TRANSCRIBE_API_KEY` / `IMSG_TRANSCRIBE_MODEL`
env vars are still honored — they map to an implicit provider profile appended to the audio chain. See
the server env-var table below.

### Contacts

| Tool | Required args | Key options |
|---|---|---|
| `list_contacts` | — | `limit` (default 20, internal safety cap 5000), `offset` for paging |
| `search_contacts` | `query` | `limit` (default 20, `0`=unlimited capped at 1000) |
| `get_contact` | `handle` or `id` | Includes `threads: [{handle, threadSlug}]` — each handle's conversation slug |
| `resolve_conversation` | `query` | `limit` (default 10, cap 50). Ranked `[{name, threadSlug, chatIdentifier, lastMessageDate, matchType, score}]` fusing contacts + thread names + message content |
| `resolve_handle` | `handle` | — |

`contact:N` selector: when a search has multiple matches, the result lists numbered candidates. Subsequent tool calls can pass `contact:1` / `contact:2` / etc. (process-wide LRU; resets on server restart).

**Typical agent workflow:** for a free-form name ("check Selena's messages"), `resolve_conversation "selena"` gets you a ranked thread list in one call — use the top match's `threadSlug`/`chatIdentifier` directly. When you need the full contact record or a disambiguation menu, fall back to `search_contacts "alex"` → pick a match → `get_contact` (returns every phone/email **and the thread slug for each**) → `send_message {threadSlug}` or `get_messages`/`export_messages`. The same flow is on the CLI: `imsg resolve "selena"`, `imsg contacts search alex`, `imsg contacts show <handle-or-id>`, `imsg contacts resolve <handle>`, `imsg contacts list [limit] [offset]`.

### Diagnostics

| Tool | Notes |
|---|---|
| `check_imessage_availability` | Preflight a handle — returns `service: "iMessage"\|"SMS"\|"unknown"` + `hint`. Authoritative when conversation history exists; best-effort for never-messaged handles. |
| `chat_analytics` | `type` + window. 7 types shipped incl. `relationship_leaderboard` (top relationships by volume × reciprocity × recency); 20 reserved (see [STATUS.md](STATUS.md#1-analytics--20-remaining-types-p2)). Cached per-window. |
| `init_human` | Scaffold a humans/v1 relationship file (`~/.agents/humans/<person>.md`) for a `contact`, `threadSlug`, or `top: N` relationships. Prefills identity + history stats; never overwrites; the AGENT writes the summaries (see [skills/humans/SKILL.md](../skills/humans/SKILL.md)). |

**Humans-file hints:** once a relationship file exists, tools that touch that person surface it automatically so agents actually use it — `get_messages` and `wait_for_reply` include a `humans` block (file path(s) — one per participant for groups — plus standing guidance: consult before replying, append milestones to the Log, suggest Summary updates to the user for approval, never share contents), `get_contact` includes `humansFile` (or an init_human pointer when none exists), and `list_conversations` rows carry `humansFiles` paths.

### Dev-only (require `IMSG_DEV=1`)

| Tool | Notes |
|---|---|
| `health_check` | Vitals. Capped at 5s — verify the server is alive when other tools hang. |
| `get_logs` | In-memory + on-disk NDJSON. `source: memory \| file \| all`. |
| `get_last_send_error` | Last `send_message` failure detail. |
| `request_restart` | Graceful exit → host respawns. |
| `run_build` | `pnpm build` (development convenience). |

---

## MCP Resources

The server exposes resources under two URI schemes for hosts that prefer resource discovery over tool calls:

- `messages://thread/<slug>` — last 50 messages of a conversation
- `messages://unread` — current unread snapshot
- `contacts://list` — every contact + every handle
- `contacts://handle/<phone-or-email>` — contact for a specific handle

---

## TUI keybindings

### Conversation pane (sidebar)

| Key | Action |
|---|---|
| `j` / `k` | Move down / up |
| `gg` / `G` | Top / bottom |
| `Ctrl-d` / `Ctrl-u` | Half-page down / up |
| `/` | Filter (any substring of name or last message) |
| `y` | Copy thread slug |
| `i` | Open per-thread **info / attachment drawer** (see below) |
| `Enter` / `Tab` / `l` / `→` | Open messages pane |
| `c` | Compose in current thread (or in new thread if none selected) |
| `N` | Compose to new recipient — opens picker (phone / email / contact name typeahead, with vanity-letter parsing) |
| `S` | Send via other app (URL-scheme picker) |
| `r` | Refresh |
| `,` | Open the **settings panel** (media-interpretation config — see below) |
| `d` | Toggle dev stats panel |
| `q` | Quit |

### Message pane

| Key | Action |
|---|---|
| `j` / `k` | Move down / up |
| `gg` / `G` | Top / bottom |
| `Ctrl-d` / `Ctrl-u` | Half-page down / up |
| `{` / `}` | Previous / next sender group |
| `Enter` | Open drawer |
| `o` | Open first attachment in Quick Look (nudges a download first if the file isn't on disk) |
| `f` | Reveal the attachment in Finder (`open -R`) |
| `R` | Run / retry media interpretation for the selected message (transcribe voice note, caption image/video) |
| `:` | Date jump modal |
| `V` | Visual select mode |
| `y` (in select) | Copy selected text |
| `e` (in select) | Open export modal |
| `Tab` / `h` / `←` | Back to sidebar |

### Info / attachment drawer (`i`)

Press `i` on a selected thread in the sidebar to open a side-column drawer showing thread metadata
(name, slug, service, group/direct, participant count, message count, first→last date range) plus a
browsable list of **every** attachment in the conversation — across all merged legs (phone + email,
SMS + iMessage), stickers and plugin payloads excluded, newest first.

| Key | Action |
|---|---|
| `j` / `k` | Select next / previous attachment |
| `g` / `G` | First / last attachment |
| `o` | Open the selected attachment (images → Quick Look, video → mpv); nudges a download first if not on disk |
| `s` | Save the selected attachment to `~/Downloads` (collision-safe name) |
| `f` | Reveal the selected attachment in Finder (`open -R`) |
| `y` | Copy the selected attachment's file path |
| `a` | Export **all** the thread's attachments to `~/Downloads/imsg-<slug>/` |
| `Esc` / `q` | Close the drawer |

### Settings panel (`,`)

Press `,` from the sidebar to open the media-interpretation settings panel (also reachable from the
command palette). It reads/writes the `interpret` block of `config.json` live.

| Key | Action |
|---|---|
| `j` / `k` (or arrows) | Move between settings rows |
| `g` / `G` | First / last row |
| `Space` / `Enter` | Toggle the selected row (auto-mode, inline transcripts, nudge tiers) |
| `h` / `l` (or ← / →) | Cycle the selected value left / right (e.g. export threshold, auto-mode) |
| `K` / `J` | Move the selected chain leg up / down (reorder the chain) |
| `Esc` / `q` | Close the panel (does **not** quit the app) |

Provider **profiles** are shown with a key-present indicator but are **not** edited here — key entry
is wizard/file only (`imsg setup --interactive` or `~/.imsg-mcp/credentials.json`), so keys never
touch the TUI.

---

## TUI configuration

Persist via `~/.config/imsg-mcp/config.json` (or `~/.imsg-mcp/config.json`). Flat theme keys stay at
the top level (back-compat); media interpretation lives under `interpret`:

```jsonc
{
  "theme": "powerline",
  "accentColor": "#FF6B35",
  "interpret": {
    "auto": "free",                    // "all" | "free" | "off"  (default "free")
    "inlineTranscripts": true,
    "exportConfirmThreshold": 25,      // guard: confirm above N uncached cloud calls
    "chains": {
      "audio": ["apple", "local", "provider:openrouter"],
      "image": ["provider:openrouter"],
      "video": ["provider:openrouter"]
    },
    "providers": [
      { "name": "openrouter", "preset": "openrouter",
        "models": { "transcribe": "…", "vision": "…" } }
    ],
    "nudge": { "enabled": true, "tier2SyncNow": false, "timeoutSeconds": 30 }
  }
}
```

Provider **keys are NOT stored here** — they live in `~/.imsg-mcp/credentials.json` (chmod 600),
keyed by provider name. Use `imsg setup --interactive` to configure both. Setting
`nudge.tier2SyncNow: true` opts into the UI-scripted "Sync Now" escalation, which requires the
macOS **Accessibility** permission (see README).

Theme override per-launch: `imsg tui --theme=powerline --accent=#FF6B35`.

Resolution order: CLI flag → `IMSG_TUI_*` env → config file → defaults.

### TUI environment variables

| Var | Default | Effect |
|---|---|---|
| `IMSG_TUI_THEME` | `safe` | `safe` (universal) or `powerline` (Nerd Font required) |
| `IMSG_TUI_ACCENT` | `#1982FC` | Any `#RRGGBB` — derives the whole palette |
| `IMSG_TUI_MSG_HARD_CAP` | `5000` | Bounded-window message cap |
| `IMSG_TUI_CACHE_TTL_MS` | `600000` | Per-chat cache TTL (10 min) |
| `IMSG_TUI_CACHE_STALE_MS` | `30000` | Refresh-on-reentry threshold (30s) |
| `IMSG_TUI_CACHE_MEM_PRESSURE_MB` | `200` | Evict LRU half above this |

---

## Server environment variables

| Var | Default | Effect |
|---|---|---|
| `VITE_IMSG_DB_PATH` | `~/Library/Messages/chat.db` | Override if Messages.app is sandboxed or in a non-default user dir |
| `VITE_CONTACTS_DB_PATH` | `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb` | Custom AddressBook profile |
| `VITE_ADDRESS_BOOK_UUID` | auto-discover | Pick a specific iCloud source when multiple exist |
| `VITE_SLUGS_DB_PATH` | `~/.imsg-mcp/slugs.db` | Shared multi-user install |
| `IMSG_DEV` | unset | When `1`, exposes the 5 dev tools (`health_check`, etc) |
| `IMSG_DISABLE_NATIVE` | `0` | Force the TS-only DB parser (debug) |
| `IMSG_TRANSCRIBE_PROVIDER` | unset | Opt-in cloud transcription fallback for `get_attachment` audio. Alias (`openai`, `groq`) or a raw OpenAI-compatible base URL. Requires `IMSG_TRANSCRIBE_API_KEY`. Local transcribers always take precedence. |
| `IMSG_TRANSCRIBE_API_KEY` | unset | Bearer key for the cloud transcription endpoint. Both this **and** `IMSG_TRANSCRIBE_PROVIDER` must be set for cloud to be attempted. |
| `IMSG_TRANSCRIBE_MODEL` | `whisper-1` | Model id sent to the cloud transcription endpoint. |
| `IMSG_DEFAULT_COUNTRY` | `AU` | Country for normalizing bare local phone numbers (`AU` or `US`). E.g. AU turns `0401 990 797` → `+61401990797`; US turns `555-010-0100` → `+15550100100`. Used by `send_message`, CLI `imsg send`, and the TUI `N` compose modal. |
| `IMSG_MAX_RSS_MB` | `1024` | Watchdog: kill self when RSS exceeds this |
| `IMSG_HEAP_WARN_MB` | `256` | Heartbeat: emit `level:warn` "heap exceeds threshold" when heap exceeds this (soft signal, not a kill). |
| `IMSG_EVENT_LOOP_KILL_MS` | `10000` | Watchdog: kill when p99 event-loop lag > this |
| `IMSG_EVENT_LOOP_SUSTAINED_MS` | `750` | Watchdog: sustained-lag kill threshold |
| `IMSG_EVENT_LOOP_SUSTAINED_SAMPLES` | `6` | Consecutive samples before sustained kill |
| `IMSG_RESTART_AFTER_MS` | `86400000` (24h) | Idle uptime auto-restart |
| `IMSG_RESTART_QUIET_MS` | `3600000` (1h) | Required idle window for auto-restart |
| `IMSG_LOG_VERBOSE` | unset | When `1`, log every DB query + arg |

---

## Tool timeouts

In `src/mcp-tools.ts:TOOL_TIMEOUTS_MS`. Default 30s per tool. `wait_for_reply` has its own `timeoutSeconds` arg (no wrapper). `health_check` capped at 5s.

On timeout the server returns `isError: true` so the host unblocks immediately, even if the underlying SQL keeps running.
