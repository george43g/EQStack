#set page(paper: "a4", margin: 1.8cm, numbering: "1")
#set text(size: 9.5pt)
#set heading(numbering: "1.")
#show link: set text(fill: rgb("#1a56a0"))
#let sha = "d604a8b"
#let T(x) = text(size: 7pt, fill: luma(110))[#x]   // theirs cite
#let adopt = rgb("#c8ecc8"); #let later = rgb("#fff1b8"); #let skip = rgb("#e3e3e3")
#let bg(t) = if t.starts-with("now") { adopt } else if t.starts-with("later") { later } else { skip }

#align(center)[
  #text(size: 18pt, weight: "bold")[openclaw/imsg vs imsg-mcp: feature and UX sweep] \
  #text(size: 10pt)[Research wave R1a, 2026-10-08. Their repo pinned at commit `d604a8be548a637faa35fe968af426c7484ded67` (v0.15.10). Ours: EQStack `91b08bb`.]
]

= Executive summary

*The most important finding: openclaw/imsg is not an MCP server.* A repo-wide case-insensitive search for "mcp" finds one hit, in an unrelated Swift source file (`Sources/IMsgCore/MessageStore+ServiceAvailability.swift` @ #sha). It is a Swift *CLI* (`imsg`) plus a *JSON-RPC 2.0 over stdio* server (`imsg rpc`, `docs/rpc.md:1-9` @ #sha) that OpenClaw supervises as a child process (`docs/rpc.md:99` @ #sha). So the comparison is "their CLI+RPC surface" against "our MCP tools + CLI + TUI". We win on agent ergonomics (typed MCP tools, thread slugs, resolve-by-name, media understanding, export, analytics, humans files, prompt-injection wrapping). They win on *send honesty*, *resumable cursors*, *capability/permission diagnostics*, *reaction/poll/scheduled coverage*, and *distribution polish*.

Their biggest strategic split: everything that needs IMCore injection (read receipts, typing, edit, unsend, threaded replies, stickers, polls, group management, effects) requires *SIP disabled* (`README.md:87-89`, `docs/advanced-imcore.md` @ #sha). Their SIP-free surface (chats, history, search, watch, stats, AppleScript send, UI-scripted tapbacks) is the part that is portable to our no-SIP posture. Most "adopt" items below come from that half.

*Top 10 adopt-now (ranked by value over effort for a no-SIP MCP product):*

#table(columns: (auto, 1fr, auto, auto), inset: 4pt, stroke: 0.4pt + luma(180),
  [*\#*], [*Item and one-line reason*], [*Effort*], [*Their evidence*],
  [1], [Typed delivery disposition on every failed/uncertain send (`not_started` retry-safe, `may_have_completed`, `still_in_flight`) plus `retry_safe` boolean. We return `delivered|failed|pending` but give agents no retry contract; double-sends are the worst agent failure.], [S-M], [#T[`docs/send.md:72-98`, `docs/rpc.md:123-136`]],
  [2], [Tahoe (macOS 26) ghost-row detection after AppleScript send (success reported, empty unjoined SMS row written). We have no equivalent; grep of our `src/` finds none.], [S], [#T[`docs/send.md:113-122`]],
  [3], [Resumable cursor API: `since_rowid` in, `next_rowid` and `has_more` out, plus a terminal overflow notice carrying `resume_after_rowid`. Our `wait_for_changes` is push-fed but gives agents no durable cursor to survive restarts.], [M], [#T[`docs/rpc.md:304-345`, `docs/watch.md:25-45,104-120`]],
  [4], [One `status` snapshot: per-gate readiness (Full Disk Access, Automation, Contacts), DB feature flags, methods usable *right now*, never launching anything. Ours: `doctor` CLI and dev-only `health_check`; no always-on MCP preflight.], [S-M], [#T[`docs/rpc.md:155-207`, `docs/permissions.md:94-98`]],
  [5], [Standard tapback send (six kinds) via UI automation, verified by waiting for the new outgoing reaction row in `chat.db`. We read reactions but cannot send any.], [M], [#T[`docs/send.md:124-141`, `CHANGELOG.md` 0.15.8-0.15.9]],
  [6], [Fail-closed request validation: unknown keys rejected, strict types, explicit alias lists. Our Zod output schemas are not `.strict()` (grep finds no `.strict()` in `src/mcp-schemas.ts`); verify input side before acting.], [S], [#T[`docs/rpc.md:22-48`]],
  [7], [Return the sent message's `id` + `guid` on send, and keep verification scoped to the *actual* route after SMS fallback. We return `lastMessageId` already (partial); add `guid` and route.], [S], [#T[`docs/rpc.md:519-552`, `docs/send.md:100-111`]],
  [8], [Search quality: Unicode case-insensitive, literal `%` `_` `\`, matches attributed bodies and *stored audio transcripts*, each physical message once across linked chats, `match: exact|contains`. Add `exact` mode and transcript matching to `search_messages`.], [S], [#T[`docs/rpc.md:283-302`]],
  [9], [Group attachment sends: they stage into `~/Library/Messages/Attachments/imsg/` and send to `chat id` for groups. Our docs say file sends to groups are unreliable (1-on-1 only). Test their staging path in our sender.], [M], [#T[`docs/groups.md` Sending to a group, `docs/attachments.md:60-70`]],
  [10], [URL-preview balloon coalescing in history/search/watch (text row + later `URLBalloonProvider` row folded into one message with a `url_preview` object). We classify balloon types but I found no coalescing (not verified in depth).], [S-M], [#T[`docs/json.md:110-120`, `docs/watch.md:149-151`]],
)

Honourable mentions (adopt-later): `completions llm` generated agent reference, scheduled-message read, native poll read model, multi-number routing diagnostics, Homebrew/notarized distribution, docs site.

= Method, limits and diagram tooling

- Cloned `--depth 1` to `openclaw-imsg/` (workdir `.../scratchpad/research/r1a`), HEAD `d604a8be548a637faa35fe968af426c7484ded67`. Read README, all 19 files in `docs/`, `CHANGELOG.md`, command specs under `Sources/imsg/Commands/`, `gh release list`, and `gh issue list` (3 open issues: #334 bridge helper lookup list, #332 arbitrary-emoji tapback send, #328 SSH AddressBook delegate-contact precedence).
- Ours: `apps/imsg-mcp/{AGENTS.md,README.md,docs/TOOLS.md,src/mcp-tools.ts}`, `docs/STATUS.md` @ `91b08bb`. Read only.
- *Not verified:* I did not build or run `imsg` (no Swift build, no live Messages). Everything about their behaviour is from their docs and source text, not execution. Claims about macOS 26/27 behaviour are theirs. Internals (algorithms, structure) are R1b's. No personal data is quoted.
- Diagram tools: `command -v d2 dot mmdc plantuml` found none. The overlap map in section 4 is drawn with native Typst grid cells (no external packages), so it compiles offline.
- Issue/release data: GitHub CLI; the open-issue list shows only three, so user-pain evidence is thin and mostly comes from `CHANGELOG.md` fix entries.

= Their surface at a glance

*Distribution:* Homebrew tap `steipete/tap/imsg`; signed, notarized universal macOS binary; Linux x86_64 read-only archive (`docs/install.md:5-30`, release assets `imsg-macos.zip`, `imsg-linux-x86_64.tar.gz`). macOS 14+. No daemon, no Node (`docs/install.md` "What you don't need").

*CLI commands (from `Sources/imsg/Commands/*.swift` abstracts @ #sha):* `chats`, `group`, `history`, `search`, `watch`, `stats`, `scheduled`, `status`, `account`, `whois`, `nickname`, `name-photo`, `chat-background`, `completions`, `rpc`, `launch`, `send`, `react`; SIP-gated: `read`, `typing`, `send-rich`, `send-multipart`, `send-attachment`, `send-sticker`, `tapback`, `edit`, `unsend`, `delete-message`, `notify-anyways`, `poll send|vote|unvote`, `chat-create`, `chat-name`, `chat-photo`, `chat-add-member`, `chat-remove-member`, `chat-leave`, `chat-delete`, `chat-mark`.

*RPC methods (`docs/rpc.md` @ #sha):* `initialize`, `status`, `chats.list`, `chats.create`, `messages.history`, `messages.search`, `messages.after`, `messages.scheduled`, `messages.stats`, `watch.subscribe/unsubscribe`, `bridge.events.subscribe`, `send`, `send.tracked`, `send.rich`, `send.attachment`, `send.multipart`, `message.send_status`, `tapback`, `message.edit/unsend/delete/notifyAnyways`, `group.setIcon`, `handles.check`, poll methods, sticker, contact-card methods.

*Config surfaces:* essentially flags and `IMSG_*` env (e.g. `IMSG_LAUNCH_READY_TIMEOUT`, `CHANGELOG.md` 0.15.2); `--db` path flag everywhere; no config file found. Contrast ours: `config.json`, `credentials.json`, setup wizard.

*Output contract:* `--json` is NDJSON, human text on stderr only (`README.md:73`, `docs/json.md:11`); numeric selectors validated up front (`README.md:75`).

= Feature-overlap map

#let cell(txt, kind) = rect(width: 100%, inset: 3pt, radius: 2pt, fill: if kind == "both" { rgb("#c8ecc8") } else if kind == "ours" { rgb("#bcd8f5") } else if kind == "theirs" { rgb("#f6c9c0") } else { rgb("#e8e8e8") }, text(size: 7.5pt)[#txt])
#figure(
  grid(columns: (1fr, 1fr, 1fr), gutter: 4pt,
    [*Theirs only* (we lack)], [*Both*], [*Ours only* (they lack)],
    [
      #cell("Tapback send (UI-scripted, verified)", "theirs")
      #cell("Typed retry-safe delivery dispositions", "theirs")
      #cell("Ghost-row detection (macOS 26)", "theirs")
      #cell("Resumable ROWID cursor (messages.after)", "theirs")
      #cell("Capability/permission status snapshot", "theirs")
      #cell("Scheduled (Send Later) read", "theirs")
      #cell("Native poll read model", "theirs")
      #cell("Multi-number routing diagnostics", "theirs")
      #cell("Chat background status", "theirs")
      #cell("completions llm / shell completions", "theirs")
      #cell("Brew + notarized binary, docs site", "theirs")
      #cell("SIP-gated: edit, unsend, replies, stickers, group mgmt, typing, read", "none")
    ],
    [
      #cell("List chats, history, date/participant filters", "both")
      #cell("Search (theirs: exact/contains; ours: fuzzy+literal)", "both")
      #cell("Live watch (kqueue WAL + poll fallback)", "both")
      #cell("AppleScript text send + SMS/iMessage routing", "both")
      #cell("Attachment metadata + path resolution", "both")
      #cell("Attributed-body text recovery", "both")
      #cell("Contacts name resolution from AddressBook", "both")
      #cell("Group detection, participants", "both")
      #cell("Reaction read (watch / change events)", "both")
      #cell("Aggregate stats", "both")
      #cell("Read-only DB mode on fixtures / Linux", "both")
    ],
    [
      #cell("Real MCP server (18 typed tools, resources)", "ours")
      #cell("Thread slugs, merged cross-handle identity", "ours")
      #cell("resolve_conversation / resolve_handle", "ours")
      #cell("Media interpretation chain + cache", "ours")
      #cell("Export (md/csv/json/ndjson, streaming)", "ours")
      #cell("Analytics (7 types), humans files", "ours")
      #cell("Interactive TUI", "ours")
      #cell("Group system events (rename/add/leave)", "ours")
      #cell("Edit history read, prompt-injection wrapping", "ours")
      #cell("wait_for_reply with echo suppression", "ours")
      #cell("Setup wizard, host config writer", "ours")
    ],
  ),
  caption: [Feature-overlap map. Green: both have it. Red: only openclaw/imsg. Blue: only imsg-mcp. Grey: needs SIP-off injection, out of scope.],
)

= Full comparison table

Verdict key: *L* = we lack it, *T* = theirs better, *O* = ours better, *=* equal. Triage: _now_, _later_, _skip_. Effort S/M/L. Their cites are `path:line @ #sha`; ours cite `apps/imsg-mcp` paths @ `91b08bb`.

#let rows = (
  ("Read chats list", "`chats --limit --unread-only`; `unread_count` (`docs/chats.md:82`)", "`list_conversations` with slugs, snippets, unread (`src/mcp-tools.ts:309`)", "O", "skip", "Ours richer; `unread_only` filter is trivial to add.", "-"),
  ("Read history", "`history` filters applied before limit; date/participants (`docs/history.md`)", "`get_messages`, cursor `beforeMessageId`, `hasMore` (`docs/TOOLS.md` Reading)", "=", "skip", "Equivalent.", "-"),
  ("Resumable catch-up", "`messages.after`: `since_rowid` -> `next_rowid`,`has_more` (`docs/rpc.md:304`)", "None public; internal high-water ROWID (`docs/STATUS.md` section 9)", "T", "now", "Agents need durable cursors across restarts.", "M"),
  ("Search", "`search --query --match exact|contains`, Unicode case, transcripts (`docs/rpc.md:283`)", "`search_messages` fuzzy+literal (`src/mcp-tools.ts:331`)", "=", "now", "Add exact mode + transcript matching only.", "S"),
  ("Live watch", "`watch` kqueue + poll fallback, debounce, `--reactions`, backpressure (`docs/watch.md`)", "`wait_for_changes`, WAL watcher + 10s poll (`docs/STATUS.md` section 9)", "=", "later", "Port overflow-resume contract with the cursor item.", "M"),
  ("Await reply", "None (build from watch)", "`wait_for_reply` w/ self-interjections, echo suppression (`src/mcp-tools.ts:216`)", "O", "skip", "Ours unique.", "-"),
  ("Send text", "`send` with verification, service select, region (`docs/send.md`)", "`send_message` routes on real thread service (`AGENTS.md` Sending)", "T", "now", "Verified row + typed disposition (top-10 #1,#2,#7).", "S-M"),
  ("Service override", "`--service auto|imessage|sms`, `--no-sms-fallback` (`docs/send.md:72`)", "Auto only, no override arg", "T", "later", "Expose `service` + fallback toggle for power users.", "S"),
  ("Phone region", "`--region` ISO code (`docs/send.md`)", "`handle-normal.ts` (no per-call region; unverified)", "T", "later", "Cheap arg.", "S"),
  ("Attachment send", "`--file`, staged copy, groups ok (`docs/attachments.md:60`)", "`attachments[]`, staged in `imsg-mcp-staging`, 1-on-1 only (`docs/TOOLS.md`)", "T", "now", "Try group path; verify with receipt join.", "M"),
  ("Voice message send", "`--audio` CAF/Opus via afconvert, bridge only (`docs/attachments.md:80`)", "None", "L", "skip", "Needs SIP-off bridge.", "L"),
  ("Tapback send", "Six kinds, UI automation + DB confirm (`docs/send.md:124`)", "Read only (analytics + events)", "L", "now", "Common agent expression; needs Accessibility.", "M"),
  ("Arbitrary emoji tapback", "Rejected; open issue #332", "None", "=", "skip", "No reliable surface exists.", "-"),
  ("Reply to message", "Native threaded reply, bridge only (`docs/bridge.md`)", "Reads `ReplyContext` (`src/reply-preview.ts`)", "O/L", "skip", "Read yes, write needs SIP-off.", "L"),
  ("Edit / unsend", "Bridge only (`docs/bridge.md:Message and chat mutation`)", "Edit history read (`src/edit-history.ts`)", "O", "skip", "Reading is the reachable half.", "-"),
  ("Effects, subjects, rich text, stickers, multipart", "Bridge only", "None", "L", "skip", "SIP-off.", "L"),
  ("Polls", "Create/vote bridge-only; read model in history/watch (`docs/json.md`)", "None", "L", "later", "Read-only poll decode is SIP-free; niche.", "M"),
  ("Scheduled messages", "`scheduled list`, `messages.scheduled` (`docs/rpc.md:347`)", "None", "L", "later", "SIP-free read; useful to avoid double-send.", "S"),
  ("Group management", "Create/rename/photo/add/remove/leave/delete, bridge-only", "None; reads system events (`get_conversation_events`)", "O/L", "skip", "SIP-off.", "L"),
  ("Group events read", "Not found in docs (unknown)", "`get_conversation_events` (`src/mcp-tools.ts:284`)", "O", "skip", "Ours unique.", "-"),
  ("Mark read / typing", "Bridge only (`docs/advanced-imcore.md`)", "None", "L", "skip", "SIP-off.", "L"),
  ("Reachability check", "`handles.check` IDS via bridge (`docs/rpc.md:663`)", "`check_imessage_availability` best-effort from history (`src/mcp-tools.ts:477`)", "T", "skip", "Real IDS needs SIP-off; ours honest about limits.", "-"),
  ("Contacts", "Contacts.framework + SSH AddressBook fallback (`docs/permissions.md:73`)", "AddressBook DB direct, merge across sources (`docs/CONTACT_MERGE_AND_SLUGS.md`)", "O", "skip", "Ours merges identities; theirs has open delegate bug #328.", "-"),
  ("Name -> thread", "None (use chats + jq)", "`resolve_conversation`, `contact:N` selectors", "O", "skip", "Ours unique.", "-"),
  ("Stats/analytics", "`stats` totals, per chat/sender/date, `--media` (`docs/stats.md`)", "`chat_analytics` 7 types + cache", "O", "later", "Add media-bytes breakdown only.", "S"),
  ("Export", "None (use history + jq)", "`export_messages` md/csv/json/ndjson, streaming", "O", "skip", "Ours unique.", "-"),
  ("Attachment access", "Metadata, path, `--convert-attachments` via ffmpeg (`docs/attachments.md:36`)", "`get_attachment` image blocks, posters, interpretation chain", "O", "skip", "Ours unique.", "-"),
  ("URL preview folding", "Folds balloon rows (`docs/json.md:110`)", "Balloon type classify only (unverified)", "T", "now", "Avoid duplicate rows in reads.", "S-M"),
  ("Routing diagnostics", "`account_id`, `account_login`, `destination_caller_id` (`docs/groups.md`)", "None found in `src/`", "L", "later", "Helps multi-number setups.", "S"),
  ("Status / doctor", "`status` + typed RPC error codes (`docs/rpc.md:155`)", "`doctor` CLI, dev `health_check`", "T", "now", "Always-available MCP preflight.", "S-M"),
  ("Strict validation", "Unknown keys rejected (`docs/rpc.md:22`)", "Zod; strictness unverified", "T", "now", "Fail-closed inputs.", "S"),
  ("Prompt-injection hygiene", "Not found (unknown)", "`wrapUntrusted` (`src/mcp-format.ts:101`)", "O", "skip", "Ours unique.", "-"),
  ("Shell completions + LLM ref", "`completions bash|zsh|fish|llm` from one spec (`docs/completions.md:42`)", "`imsg tools`, hand-written TOOLS.md", "T", "later", "Generate TOOLS.md from tool defs.", "S"),
  ("Linux / offline DB", "Read-only Linux archive (`docs/linux.md`)", "`VITE_ENV=ai` mocks + fixtures (`AGENTS.md` Env layout)", "=", "later", "Document `--db`-style read-only mode.", "S"),
  ("TUI", "None", "Full Ink TUI", "O", "skip", "Ours unique.", "-"),
  ("Install", "Brew, notarized binary (`docs/install.md`)", "`npx -y`, `.mcpb` bundle (`README.md` Install)", "=", "later", "Brew tap for the CLI/TUI; low urgency.", "M"),
  ("Docs", "imsg.sh site, per-topic pages, troubleshooting map", "README + TOOLS.md + WORKFLOWS.md", "T", "later", "Add troubleshooting-by-symptom page.", "S"),
  ("Concurrency/lane model", "FIFO mutation lane, 4 concurrent reads, poison on in-flight (`docs/rpc.md:101-140`)", "30s tool timeouts, no lane model", "T", "later", "Design is R1b territory; UX point: block sends after uncertain one.", "M"),
)
#table(
  columns: (1.05fr, 1.7fr, 1.7fr, 0.35fr, 0.5fr, 1.35fr, 0.4fr),
  inset: 3.5pt, stroke: 0.3pt + luma(170),
  fill: (c, r) => if r == 0 { luma(225) } else if c == 4 { bg(rows.at(r - 1).at(4)) } else { none },
  table.header[*Feature*][*Theirs*][*Ours*][*V*][*Triage*][*Reason*][*Eff*],
  ..rows.map(r => (text(size: 7.5pt)[#r.at(0).replace("`", "")], text(size: 7pt)[#r.at(1).replace("`", "")], text(size: 7pt)[#r.at(2).replace("`", "")], text(size: 7.5pt)[#r.at(3).replace("`", "")], text(size: 7.5pt)[#r.at(4).replace("`", "")], text(size: 7pt)[#r.at(5).replace("`", "")], text(size: 7.5pt)[#r.at(6).replace("`", "")])).flatten(),
)

= UX and discoverability lessons

+ *Onboarding names the exact gate.* Their permissions page maps each failure to one of three gates (Full Disk Access, Automation, Contacts) in a table (`docs/permissions.md:94-98` @ #sha) and says grant the *parent process*, relaunch, and toggle off/on for stale TCC records (`docs/permissions.md:100`). Our README lists the three permissions but not stale-grant or parent-process advice (`README.md` Permissions). Lift both into `doctor` output.
+ *Degrade, do not die.* `imsg rpc` starts without database access; `initialize` and `status` still answer and DB methods return typed retryable `-32002` (`docs/rpc.md:18-20,54-56`). An MCP server that comes up with FDA missing and *explains itself through a tool* beats a host showing "server failed to start".
+ *Silence is never success.* Their `react` and `send` now refuse to report success unless they observe the new outgoing row (`CHANGELOG.md` 0.15.8, `docs/send.md:100`). Same principle as our `status: pending`; theirs adds the typed no-retry rule.
+ *Errors carry a retry contract, not prose.* "Never infer retry safety from human-readable error text" (`docs/bridge.md:215-232`). Put `retry_safe` in `structuredContent`.
+ *Defaults are explicit and documented per surface.* CLI debounce 250 ms vs RPC 500 ms with the reason stated (`docs/rpc.md:397`). Document why each of our timeouts differs (`src/mcp-tools.ts:96-105`).
+ *Self-describing CLI for models.* `completions llm` emits a Markdown reference generated from the same `CommandSpec` the parser uses, so docs cannot drift (`docs/completions.md:42-50`). Our `TOOLS.md` is hand-written; `scripts/check-docs-integrity.mjs` partly covers drift.
+ *Help is example-first.* Every spec carries `usageExamples` (`Sources/imsg/Commands/BridgeIntroCommands.swift:27` @ #sha), and the README's pitch is four one-liners (`README.md:15-20`). Our README leads with install JSON; consider a four-line "first five minutes" block.
+ *Stdout is machine-only.* Progress and warnings to stderr; NDJSON on stdout (`docs/json.md:11`). Our MCP stdio server already needs this; check our CLI `--json` honours it (unverified).
+ *Troubleshooting is symptom-indexed* (`docs/troubleshooting.md`): "Sends report success but never arrive", "watch goes silent", "Contacts names are missing". Ours has `get_last_send_error` but no symptom page.
+ *Honest limits stated up front.* "Cannot force a specific outgoing number" (`docs/send.md:143-148`), "react cannot guarantee a specific message target" (`docs/send.md:130`). We should publish equivalent limits for group file sends.
+ *Caveat:* their user pain is visible in CHANGELOG fixes, not issues (only 3 open). Repeated themes: macOS-version fragility of UI/AppleScript paths (0.15.9), Contacts stalls blocking watch (0.15.6), bridge startup races (0.15.2-0.15.3). Expect the same for our tapback and attachment work.

= Open questions for George

+ Is any SIP-off feature in scope (replies, edit, unsend, polls, group management)? If not, mark all "bridge" rows permanently _skip_.
+ Tapback send needs UI scripting and so Accessibility permission (we already treat Accessibility as opt-in, `README.md` Permissions). Acceptable as another opt-in?
+ Do we want a cursor-based catch-up tool (`get_messages_after`) alongside `wait_for_changes`, or fold the cursor into the existing events payload?
+ Should `send_message` stay "route on the thread's real service" or expose their `service` and `allow_sms_fallback` knobs?
+ Does OpenClaw consume only their RPC (so are they a *consumer* of our surface later, requiring an RPC-compatible adapter)? Unknown from this repo.
+ Unknown, to verify before building: whether our sender already detects ghost rows; whether our MCP input schemas reject unknown keys; whether group file sends actually work via staged path on current macOS.
