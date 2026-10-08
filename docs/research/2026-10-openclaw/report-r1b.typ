#import "@preview/fletcher:0.5.8": diagram, node, edge

#set document(title: "R1b - openclaw/imsg: structure and algorithms")
#set page(paper: "a4", margin: (x: 1.8cm, y: 2cm), numbering: "1 / 1")
#set text(size: 9.5pt, lang: "en")
#set par(justify: false, leading: 0.6em)
#set heading(numbering: "1.1")
#show heading.where(level: 1): set text(size: 15pt)
#show heading.where(level: 2): set text(size: 11.5pt)
#show raw: set text(size: 8pt)

#let sha = "d604a8b"
#let our = "91b08bb"
// citation helpers: T = openclaw/imsg (theirs), O = EQStack apps/imsg-mcp (ours)
#let T(p) = raw(p + " @ " + sha)
#let O(p) = raw(p + " @ " + our)
#let tag(label, col) = box(fill: col.lighten(80%), stroke: 0.5pt + col, inset: (x: 4pt, y: 1.5pt), radius: 2pt, text(size: 8pt, weight: "bold", label))
#let ADOPT = tag("ADOPT", green.darken(20%))
#let ADAPT = tag("ADAPT", blue)
#let HAVE = tag("WE ARE AHEAD", gray.darken(30%))
#let SKIP = tag("SKIP", red)
#let NOFIND = tag("NOT IN THEIR REPO", orange)

#let area(title, theirs, ours, verdict, lands) = block(breakable: true, width: 100%)[
  == #title
  #table(
    columns: (2.0cm, 1fr),
    stroke: 0.4pt + luma(170),
    inset: 5pt,
    fill: (x, y) => if x == 0 { luma(240) } else { none },
    [*Theirs*], theirs,
    [*Ours*], ours,
    [*Verdict*], verdict,
    [*Lands in*], lands,
  )
]

#align(center)[
  #text(size: 19pt, weight: "bold")[openclaw/imsg: structure and algorithms] \
  #v(2pt)
  #text(size: 11pt)[Research report R1b, input to the media and MCP platform redesign] \
  #v(2pt)
  #text(size: 9pt, fill: luma(90))[
    Subject: github.com/openclaw/imsg, commit `d604a8be548a637faa35fe968af426c7484ded67` (2026-10-06, version 0.15.10) \
    Compared against: EQStack `apps/imsg-mcp` at `91b08bb` (read-only) \
    Plan this serves: `docs/plans/2026-10-08-mcp-platform-and-media.md` (plan worktree) \
    Diagram tool: Typst `@preview/fletcher` 0.5.8 (d2, dot and mmdc are not installed on this machine)
  ]
]

#v(6pt)
*Citation convention.* Every claim is `path:line @ sha`. Their paths are repo-relative to openclaw/imsg and carry `#sha` (short form of the full SHA above). Our paths are relative to `apps/imsg-mcp/` and carry `#our`. "Unknown" means I did not find evidence; it never means "no".

= Executive summary

*The first finding changes the brief.* openclaw/imsg is a Swift CLI plus a JSON-RPC-over-stdio server plus an injected Objective-C dylib. It is *not* an MCP server, and it has *no* OCR, no speech-to-text, no vision calls, no interpretation cache and no MIME inference. A repo-wide search of `Sources/**/*.swift` for `vision`, `VNRecognize`, `SFSpeech`, `transcri`, `whisper` and `OCR` (case-insensitive) finds exactly two things: the reader of Apple's *stored* voice-memo transcript (#T("Sources/IMsgCore/MessageStore+Attachments.swift:20-97")) and an unrelated AppleScript UI element name (#T("Sources/imsg/Commands/ReactCommand.swift:203")). A search for `MCP`, `JSON Schema` and `openapi` finds only prose in docs. So of our seven named structural problems, openclaw/imsg gives direct answers to *three* (god file, three-frameworks/drift, honest pagination as a side effect), partial answers to *three* (dates, MIME, plugin payloads), and *nothing* for two (single interpretation slot, cache provenance). Where it has nothing, I say so rather than stretch.

It is still valuable, mainly as a very carefully engineered *data-access and transport* codebase: 22,219 lines of Swift in `Sources/imsg` and `Sources/IMsgCore`, 26,595 lines of tests with 816 `@Test` cases, 7,280 lines of Objective-C helper (counts from `find`/`wc` over the clone). Its strengths are boring in the good way: capability probing instead of version sniffing, one row-decoding path, typed delivery failures, bounded everything.

== Scorecard against our known problems

#table(
  columns: (3.3cm, 1fr, 2.6cm),
  stroke: 0.4pt + luma(170),
  inset: 5pt,
  table.header([*Our problem*], [*What openclaw/imsg does*], [*Value*]),
  [Untyped Apple-epoch dates],
  [Converts at one boundary (`appleEpoch(Date)` and `appleDate(from:)`, #T("Sources/IMsgCore/MessageStore+Helpers.swift:39-55")); user dates parsed by a parser that *throws* (#T("Sources/IMsgCore/MessageFilter.swift:14-26")). But it assumes *every* column is nanoseconds and never reads `attachment.created_date`, so it dodges our unit bug rather than solving it.],
  [Shape yes, unit model no],
  [MIME/kind logic copied 5x],
  [No MIME inference at all: passes `mime_type` through (#T("Sources/IMsgCore/MessageStore+Attachments.swift:49-60")). Its one classification, the CAF/GIF conversion plan, OR-s three signals (UTI, extension, MIME) in one place (#T("Sources/IMsgCore/AttachmentResolver.swift:149-174")).],
  [Pattern yes, code no],
  [Plugin-payload filtering],
  [Treats plugin payloads as *message rows* identified by `balloon_bundle_id` and coalesces URL previews into the preceding text row (#T("Sources/IMsgCore/MessageStore+URLPreviews.swift:13-98")). Read side has no filter for `.pluginPayloadAttachment` attachment rows; that suffix appears only on the send side (#T("Sources/imsg/RichLinkPreparer+LinkPresentation.swift:23")).],
  [A new signal for our predicate],
  [One interpretation slot per message],
  [Not present. No interpretation concept exists.],
  [None],
  [Cache with no provenance],
  [Not present for interpretations. Its only cache (converted audio/GIF) is content-addressed by path, size and mtime (#T("Sources/IMsgCore/AttachmentResolver.swift:62-78")).],
  [Weak hint only],
  [2892-line god file],
  [Largest `IMsgCore` source file is 500 lines; the store is 23 `MessageStore+*.swift` extensions over a shared schema struct, row-selection builder and query structs (#T("Sources/IMsgCore/MessageStoreSchema.swift:3-53"), #T("Sources/IMsgCore/MessageStore+MessageRows.swift:94-152")).],
  [High, directly reusable design],
  [Three MCP frameworks],
  [No MCP. Its RPC layer is one descriptor table driving dispatch, lane scheduling, capability gating and the advertised method list (#T("Sources/imsg/RPCMethodDescriptors.swift:56-247")), with fail-closed parameter parsing (#T("Sources/imsg/RPCParameters.swift:4-51")).],
  [High, maps onto mcp-kit v3],
)

== Top 10 structural lessons, ranked by impact on our known problems

#set enum(numbering: "1.")
+ *Split the store by concern around three shared objects, not one class.* A capability struct built once from `PRAGMA table_info` (#T("Sources/IMsgCore/MessageStoreSchema.swift:24-53")), a `MessageRowSelection` that builds the SELECT list and substitutes literal `NULL` for absent columns (#T("Sources/IMsgCore/MessageStore+MessageRows.swift:103-149")), and one `decodeMessageRow` (#T("Sources/IMsgCore/MessageStore+Messages.swift:359-421")). Every query is a small struct that owns its SQL and bindings (#T("Sources/IMsgCore/MessageStore+Queries.swift:12-135")). This is the template for dismantling `imessage-db.ts` (#O("src/imessage-db.ts:1-2892")).
+ *One descriptor table is the single source of truth for a tool/method.* Names plus aliases, route, execution lane, database requirement and bridge requirement live in one record (#T("Sources/imsg/RPCMethodDescriptors.swift:56-105")); the same table filters the advertised list so only *usable* methods are listed (#T("Sources/imsg/RPCMethodDescriptors.swift:232-237"), #T("Sources/imsg/RPCServer+StatusHandlers.swift:140")). Feed this shape into the mcp-kit v3 registry: it removes the two-definitions-per-tool drift and makes `tools/list` capability-aware.
+ *Read Apple's own voice-memo transcript from `attachment.user_info`.* They parse the binary plist and take key `audio-transcription` (#T("Sources/IMsgCore/MessageStore+Attachments.swift:67-101")), then override message text with it (#T("Sources/IMsgCore/MessageStore+Messages.swift:385-388")). We read a *different* location, the `IMAudioTranscription` attribute inside `attributedBody` (#O("src/imessage-db.ts:2088"), #O("src/attributed-body-text.ts:119")), and `grep` finds no `user_info` or `audio-transcription` anywhere in our `src/`. A second free, local, non-LLM source in front of any model call is the cheapest fix for the "CAF transcript is a cached refusal" bug.
+ *Type time at the boundary, and make parsing throw.* One `Date` in the model, one converter pair, `MessageFilter.fromISO` throws `invalidISODate` rather than returning nil (#T("Sources/IMsgCore/MessageFilter.swift:14-26")). Caveat: they assume nanoseconds everywhere (#T("Sources/IMsgCore/MessageStore+Helpers.swift:41,54")). Our branded-unit plan (AppleNanos/AppleSeconds) is strictly more correct than theirs, so take the *shape*, not the unit model.
+ *Classify media by agreeing signals in one place, and convert behind a content-addressed, atomic cache.* `uti == "com.apple.coreaudio-format" || .caf || audio/x-caf` in one predicate (#T("Sources/IMsgCore/AttachmentResolver.swift:157-160")); output name = prefix + SHA-256(path|size|mtime) (#T("Sources/IMsgCore/AttachmentResolver.swift:62-78")); write to a hidden UUID temp file then move (#T("Sources/IMsgCore/AttachmentResolver.swift:105-120")); optional converter, graceful omission (#T("Sources/IMsgCore/AttachmentResolver.swift:92-94")); report `converted_*` beside the original instead of replacing it (#T("Sources/IMsgCore/AttachmentResolver.swift:42-53")).
+ *Plugin payloads are a property of the message row.* `balloon_bundle_id` identifies the plugin (#T("Sources/IMsgCore/MessageStore+URLPreviews.swift:10,96-98")); the preview is folded into the preceding text row only if same chat, direction, sender and handle, a later ROWID, within 5 seconds, and the text contains the URL (#T("Sources/IMsgCore/MessageStore+URLPreviews.swift:74-94")). Add `message.balloon_bundle_id IS NOT NULL` to our plugin-payload predicate alongside the filename/UTI signals.
+ *Make pagination honest by construction.* Fetch `limit + 1`, trim, and return a `nextRowID` cursor with `hasMore` (#T("Sources/IMsgCore/MessageStore+Messages.swift:127-199")); when coalescing shrinks a page, double the physical limit and retry (#T("Sources/IMsgCore/MessageStore+Messages.swift:77-80,65-73")). Ours is `messages.length === limit` (#O("src/index.ts:665")), which is the heuristic the plan's B item wants to remove.
+ *Give mutations a typed delivery disposition and have the script report its own phase.* `DeliveryFailure` carries `notStarted | mayHaveCompleted | stillInFlight` and `retrySafe` (#T("Sources/IMsgCore/DeliveryFailure.swift:4-44")); the AppleScript sets `dispatchPhase` before the first `send` and returns a tab-separated `IMSG_RESULT` line (#T("Sources/IMsgCore/MessageSender.swift:210-275")); SMS fallback happens only when `retrySafe` (#T("Sources/IMsgCore/MessageSender.swift:196-198")); a `stillInFlight` result poisons the mutation lane (#T("Sources/imsg/RPCServer+Runtime.swift:126-141")). Ours does a post-hoc chat.db read (#O("src/delivery-status.ts:1-40")) and a 30 s `execFile` timeout (#O("src/applescript.ts:72-75")), which are complementary, not equivalent.
+ *Watcher hygiene we are missing.* Re-arm on inode change (#T("Sources/IMsgCore/MessageWatcher.swift:106-116,186-209")), a bounded stream whose overflow error carries `resumeAfterRowID` (#T("Sources/IMsgCore/MessageWatcher.swift:38-44,292-298")), and a retry loop (limit 20) for a message row that appears before its `chat_message_join` row (#T("Sources/IMsgCore/MessageWatcher.swift:86,335-353")). I found no equivalent of the last one in our watcher (#O("src/change-watcher.ts:1-297")); treat as *verify*.
+ *Subprocess and path hardening for the media pipeline.* Monotonic deadline, SIGTERM then SIGKILL of child and process group (#T("Sources/IMsgCore/ProcessTimeout.swift:18-60")), `openat` with `O_NOFOLLOW` per component and a regular-file check (#T("Sources/IMsgCore/AttachmentSource.swift:10-50")), and exclusive-create staging (#T("Sources/IMsgCore/AttachmentSource.swift:52-82")). Our media helpers shell out to `sips`/`qlmanage`/`afinfo` (#O("src/media.ts:1-17")); the planned `afconvert`/ffmpeg stage should inherit these controls. Same family: the build recipe for a signed, notarised Swift helper with an embedded `Info.plist` for TCC identity (#T("Package.swift:42-52"), #T("scripts/build-universal.sh:62-78")), which is what `packages/apple/intel` needs.

= Architecture of openclaw/imsg

#figure(
  scale(78%, reflow: true, diagram(
    node-stroke: 0.6pt,
    node-inset: 6pt,
    spacing: (10mm, 10mm),
    node((0, 0), [*imsg* executable \ 27 command files, Commander \ `Sources/imsg`], name: <cli>, fill: blue.lighten(85%)),
    node((2, 0), [*RPCServer* \ JSON-RPC over stdio \ lanes: mutation / read / control], name: <rpc>, fill: blue.lighten(85%)),
    node((1, 1), [*IMsgCore* library \ MessageStore, Watcher, Sender, \ ContactResolver, Attachments], name: <core>, fill: green.lighten(85%)),
    node((0, 2), [*chat.db* \ SQLite, opened read-only \ (+ WAL, SHM)], name: <db>, fill: yellow.lighten(80%)),
    node((1, 2.1), [*AddressBook v22* \ / Contacts.framework], name: <ab>, fill: yellow.lighten(80%)),
    node((2, 2), [*Messages.app* \ via osascript], name: <msg>, fill: yellow.lighten(80%)),
    node((3, 1), [*IMsgHelper* dylib (Obj-C) \ injected into Messages.app \ private IMCore, needs SIP off], name: <dylib>, fill: red.lighten(85%)),
    node((3, 2.2), [file queue `.imsg-rpc/in,out` \ + `.imsg-events.jsonl`], name: <queue>, fill: red.lighten(92%)),
    node((0.2, 3.2), [ffmpeg / afconvert \ optional converters], name: <conv>, fill: gray.lighten(80%)),
    edge(<cli>, <core>, "->"),
    edge(<rpc>, <core>, "->"),
    edge(<cli>, <rpc>, "->", label: [`imsg rpc`], label-side: left),
    edge(<core>, <db>, "->", label: [read-only], label-side: right),
    edge(<core>, <ab>, "->"),
    edge(<core>, <msg>, "->", label: [AppleScript], label-side: left),
    edge(<core>, <queue>, "<->", bend: -20deg),
    edge(<queue>, <dylib>, "<->"),
    edge(<core>, <conv>, "->", label: [optional], label-side: right),
  )),
  caption: [openclaw/imsg module graph. Swift package targets from #T("Package.swift:5-53"); the helper from #T("Sources/IMsgHelper/README.md:3"); the queue protocol from #T("Sources/IMsgCore/IMsgBridgeProtocol.swift:3-23"); SIP requirement from #T("README.md:89").],
)

The package has two Swift targets and one non-Swift target. `IMsgCore` (library, 11,240 lines) depends on SQLite.swift, CSQLite (Linux only) and PhoneNumberKit, and links ScriptingBridge and Contacts (#T("Package.swift:20-30")). `imsg` (executable, 10,979 lines) depends on `IMsgCore` and Commander (#T("Package.swift:33-37")). `IMsgHelper` is a single Objective-C translation unit that `#include`s 31 `.inc` fragments (#T("Sources/IMsgHelper/README.md:3")), compiled by `clang` into a dylib (#T("Makefile:62-76")). There is no dependency on any network or ML framework.

= Per-area analysis

#area(
  "Module layout and dependency graph",
  [Library/executable split with the library owning all behaviour (#T("Package.swift:8-9")). Within `IMsgCore`, one `MessageStore` class (149 lines) is extended by 23 files named `MessageStore+Concern.swift` (Attachments, Chats, Messages, Polls, Reactions, Search, Stats, URLPreviews, Scheduled, and so on). The class itself holds only the connection, a serial queue and the schema flags (#T("Sources/IMsgCore/MessageStore.swift:4-87")). Strongly typed ids exist as `MessageID`, `ChatID`, `HandleID` (#T("Sources/IMsgCore/DatabaseIDs.swift:1-11")). Platform seams use `#if os(macOS)` inside files rather than parallel trees, so Linux compiles the same read core (#T("TestsLinux/")).],
  [One class, `IMessageDB`, 2892 lines (#O("src/imessage-db.ts:1-2892")); `Tables` constants and epoch helpers in `db-schema.ts` (#O("src/db-schema.ts:13-22")). No id types.],
  [#ADOPT the extension-per-concern layout and the three shared objects (schema, row selection, row decode). Do *not* copy their file count mechanically: Swift extensions share private state for free, whereas TypeScript needs explicit modules and an injected context.],
  [A new package `packages/apple/chatdb` (proposed) holding `schema.ts` (capability probe), `row-selection.ts`, `decode-row.ts`, and `queries/*.ts` (one file per use case). `apps/imsg-mcp/src/imessage-db.ts` shrinks to a facade. Branded `MessageId/ChatId/HandleId` types go in the same package.],
)

#area(
  "chat.db access: queries, schema versions, WAL and locking, read-only safety",
  [Opens through a `file:` URI with `mode=ro` *and* `readonly: true` (#T("Sources/IMsgCore/MessageStore.swift:25-27")), `busyTimeout = 5` seconds (#T("Sources/IMsgCore/MessageStore.swift:28")). All access serialised on one `DispatchQueue` with a re-entrancy check (#T("Sources/IMsgCore/MessageStore.swift:79-86")).

  *No version sniffing.* Capabilities are probed from `PRAGMA table_info` for four tables into 19 booleans (#T("Sources/IMsgCore/MessageStoreSchema.swift:24-53"), #T("Sources/IMsgCore/MessageStore+Helpers.swift:12-21")). SQL is built with `schema.hasX ? "m.x" : "NULL"` (#T("Sources/IMsgCore/MessageStore+MessageRows.swift:106-127")); features degrade rather than fail, for example `unreadOnly` against a schema without `is_read` is rejected explicitly (#T("Sources/IMsgCore/MessageStore+Chats.swift:159-165")).

  Open errors (`out of memory (14)`, `authorization denied`, `unable to open`) are mapped to a typed `permissionDenied` with Full Disk Access instructions (#T("Sources/IMsgCore/MessageStore+Helpers.swift:29-37"), #T("Sources/IMsgCore/Errors.swift:17-34")). A custom SQLite function `imsg_search_text` does Unicode-aware matching inside SQL (#T("Sources/IMsgCore/MessageStore+Search.swift:17-38")); search then re-checks in Swift and grows the physical limit until the page fills (#T("Sources/IMsgCore/MessageStore+Search.swift:80-140")).

  `ROWID` cursors are *physical*: for multi-chat messages the chat id is the `MIN(chat_id)` subselect (#T("Sources/IMsgCore/MessageStore+MessageRows.swift:95-97")). The RPC layer owns the database through an actor that re-validates file identity (device and inode) and re-opens when the file is replaced, never caching a failed open as terminal (#T("Sources/imsg/RPCDatabaseResources.swift:70-140")). Linux read mode uses a copy produced by SQLite's backup command, not `cp` (#T("docs/linux.md:47-53")).

  No WAL pragma, no `immutable=1`; WAL is only watched, not configured (#T("Sources/IMsgCore/MessageWatcher.swift:168-170")).],
  [`new Database(path, { readonly: true })` (#O("src/imessage-db.ts:227")); `busy_timeout = 5000` set because node:sqlite defaults to 0 (#O("src/sqlite.ts:128-132")). Column presence checked lazily with `PRAGMA table_info` per call site (#O("src/imessage-db.ts:2308")), scattered rather than held in one struct. Permission errors: `access-check.ts` (151 lines).],
  [#ADAPT the probe-once capability struct and the `NULL`-substitution SQL builder; #ADAPT the file-identity re-open for long-lived MCP processes (their own RPC docs say a replaced or restored database path must rotate to a fresh generation, #T("docs/rpc.md:77-88")). Our `readonly` open is equivalent to their second flag; whether `node:sqlite` accepts a `mode=ro` URI is unknown.],
  [`packages/apple/chatdb/schema.ts` (`probeSchema(db) -> ChatDbCapabilities`) and `open.ts` (identity-checked reopen). Capability object is also surfaced to the mcp-kit registry (lesson 2).],
)

#area(
  "Date and epoch handling, and units",
  [A single constant `appleEpochOffset = 978_307_200` (#T("Sources/IMsgCore/MessageStore.swift:5")). Bind side: `appleEpoch(Date) -> Binding` multiplies by 1e9, rejects non-finite, and falls back to a REAL binding when Int64 would overflow so a valid date is never clipped (#T("Sources/IMsgCore/MessageStore+Helpers.swift:39-49")). Read side: `appleDate(from:)` divides by 1e9 and maps null to the epoch (#T("Sources/IMsgCore/MessageStore+Helpers.swift:51-55")). The domain model carries `Date`, not integers (#T("Sources/IMsgCore/MessageStore+MessageRows.swift:67")).

  *Unit assumption:* nanoseconds, for `message.date`, `date_read` and every comparison (#T("Sources/IMsgCore/MessageStore+Messages.swift:370,418-419")). The code never selects `attachment.created_date`, which is where seconds appear, so the bug class cannot arise (#T("Tests/IMsgCoreTests/MessageDatabaseFixture.swift:102-111") shows the fixture attachment table has no such column; a repo-wide search for `created_date` returns nothing).

  User input: `ISO8601Parser` tries fractional then plain internet date-time (#T("Sources/IMsgCore/ISO8601.swift:4-14")) and `MessageFilter.fromISO` *throws* on an unparseable string (#T("Sources/IMsgCore/MessageFilter.swift:17-24")). Relative phrases like "3 days ago" are not supported by the core; `DurationParser.swift` exists in the CLI (unknown scope, not read).],
  [Two converters: `macTimestampToDate` assumes ns; `macAutoTimestampToDate` auto-detects seconds vs ns at a 1e15 boundary (#O("src/db-schema.ts:59-86")), while the header comment still says all timestamps are nanoseconds (#O("src/db-schema.ts:10")). `parseUserDate` builds local time, rejects seconds and `Z`, and returns null (#O("src/date-parse.ts:29-40")). The plan counts about 8 scattered conversions (plan, section "What's structurally wrong", item 7).],
  [#HAVE on unit awareness (their code would also mishandle `attachment.created_date`). #ADOPT the *failure semantics* (throw, never silent null; REAL-binding fallback on overflow) and the "domain model holds a real date type" rule.],
  [`packages/time/apple`: branded `AppleNanos`/`AppleSeconds`, `toBinding()` with the overflow fallback, and a per-column unit table. `packages/time/user-date`: return `Result`, keep our richer grammar. Add a property test: round-trip `Date -> binding -> Date` across 2001..2100 and across the int64 edge.],
)

#area(
  "Attachment model: MIME, UTI and extension inference, plugin payloads, stickers, link previews, CAF voice memos",
  [*Metadata* is a straight projection of `filename, transfer_name, uti, mime_type, total_bytes, is_sticker` (#T("Sources/IMsgCore/MessageStore+Attachments.swift:4-18")) plus `original_path`, `missing`, and optional `converted_path/converted_mime_type` (#T("Sources/IMsgCore/AttachmentResolver.swift:42-53")). The docs describe `mime_type` as "best-effort MIME from UTI" (#T("docs/attachments.md:26")) but the code does no inference; null stays null.

  *Conversion plan.* A record of target extension, MIME and ffmpeg argv, selected by OR-ing UTI, path suffix and MIME: CAF to M4A (`aac 128k`), GIF to first-frame PNG (#T("Sources/IMsgCore/AttachmentResolver.swift:14-18,149-174")). Output is cached under the user caches dir, named from a sanitised stem plus SHA-256 of `path|size|mtime`, written atomically (#T("Sources/IMsgCore/AttachmentResolver.swift:62-78,105-120,176-184")). A Linux build falls back to FNV-1a because CryptoKit is absent (#T("Sources/IMsgCore/AttachmentResolver.swift:186-201")).

  *CAF voice memos on receive:* Apple's transcript from `attachment.user_info` plist key `audio-transcription` (#T("Sources/IMsgCore/MessageStore+Attachments.swift:83-101")), gated on `is_audio_message` (#T("Sources/IMsgCore/MessageStore+Messages.swift:386")). *On send:* `afconvert -f caff -d opus@24000 -b 32000 -c 1`, then validated with AudioToolbox that the result is mono 24 kHz Opus with a finite non-zero duration (#T("Sources/IMsgCore/AudioMessagePreparer.swift:42-75")).

  *Stickers:* read side is only the `is_sticker` flag (#T("Sources/IMsgCore/MessageStore+Attachments.swift:11")); the send side validates size 1..512000 bytes, pixel counts and frame counts with ImageIO, and checks PNG/GIF container completeness (#T("Sources/IMsgCore/StickerAsset.swift:37-60,359-384")).

  *Link previews and plugin payloads:* see lesson 6. Row-level, keyed on `balloon_bundle_id`. #NOFIND: any read-side exclusion of `.pluginPayloadAttachment` attachment rows.],
  [`kindFromMime` (mime, then extension) in `media-intel-runtime.ts` (#O("src/media-intel-runtime.ts:84-91")), `audioFormat` in `media-providers.ts` (#O("src/media-providers.ts:141")), two TUI copies and two SQL fragments (plan item 8). Apple transcript comes from `attributedBody` only (#O("src/imessage-db.ts:2088")). No `user_info` read anywhere in `src/`.],
  [#ADOPT: (a) the second Apple-transcript source; (b) the multi-signal predicate shape; (c) hashed, atomic conversion cache with sibling `converted_*` fields; (d) `balloon_bundle_id` as an extra plugin signal; (e) the `afconvert` Opus recipe and AudioToolbox post-check for the send side. #SKIP their lack of MIME inference: that is exactly our bug.],
  [`packages/media/kind`: `classify({uti, mime, ext, balloonBundleId, isSticker}) -> {kind, mime, isPluginPayload}` plus a `kindSqlFragment()` that mirrors it; golden table tests. `packages/media/intel`: `sources/apple-transcript.ts` (tries `attributedBody` then `user_info`), `convert/` stage with the sha-keyed atomic cache. `packages/apple/chatdb`: `attachments.ts` selects `user_info` when `hasAttachmentUserInfo`.],
)

#area(
  "attributedBody and typedstream decoding",
  [63 lines. Handles three shapes: UTF-16LE with BOM `ff fe`; typedstream with header `04 0b` and the signature `streamtyped` (little-endian) or `typedstream` (big-endian); anything else decoded as UTF-8 with leading control characters trimmed (#T("Sources/IMsgCore/TypedStreamParser.swift:4-28")). For typedstream it scans for the first `01 2b` (`+`, the C-string/NSString content tag) and reads a length: a single byte, or `0x81`/`0x82` followed by a 2- or 4-byte integer in the archive's byte order; it rejects the reserved range `0x80..0x91` and any length overrun (#T("Sources/IMsgCore/TypedStreamParser.swift:30-52")). Framing by length means embedded marker bytes in the text cannot truncate it. Tests cover plain, length-prefixed and UTF-16 bodies (#T("Tests/IMsgCoreTests/MessageStoreAttributedBodyTests.swift:7-200")).],
  [Two implementations (Rust native and a TS parser) with a "does the result look trustworthy" filter of regexes for attachment GUIDs, `__kIM`, `NS*` class names and a doubled-capital heuristic for leaked length bytes (#O("src/attributed-body-text.ts:18-37")), a METADATA_PATTERNS blocklist (#O("src/attributed-body-text.ts:39-66")), a 200 ms parse timeout (#O("src/attributed-body-text.ts:74")), and a preamble matcher for `01 94|95 84 01 2b` (#O("src/parsers/typedstream-parser.ts:26-38")).],
  [#ADAPT. Their deterministic length-framed read after the first `01 2b` is smaller and has no heuristic filter. It is a candidate *primary path* with ours as fallback, but only after a differential test over a corpus (synthetic plus our existing fixtures): the first `01 2b` may not be the message body in every layout (for example messages whose first string attribute precedes the body). Whether it is has not been verified here, so it is *unknown*.],
  [`packages/apple/chatdb/decode/typedstream.ts`: port of `parseAttributedBody` as `strict`; keep the heuristic parser as `lenient`; a test harness that runs both over the fixture set and fails on disagreement.],
)

#area(
  "Contacts and identity resolution",
  [A protocol `ContactResolving` with `displayName(for:)`, `displayNames(for:)`, `searchByName` (#T("Sources/IMsgCore/ContactResolver.swift:23-31")). The catalog is a process-owned snapshot with a state machine over authorization (`authorized | addressBook | notDetermined | unavailable | restricted`), invalidation by `CNContactStoreDidChange`, a 30 s TTL, a "last good catalog" flag so a transient failure does not blank names, and bounded per-region snapshots (max 8, LRU) (#T("Sources/IMsgCore/ContactCatalog.swift:5-13,99-196,198-237"), #T("Sources/IMsgCore/ContactResolver.swift:91-106")). Headless stdin uses `skipIfNotDetermined` so a LaunchAgent never blocks on a prompt that cannot resolve (#T("Sources/IMsgCore/ContactResolver.swift:53-58")). Over SSH it reads AddressBook-v22 SQLite directly, in place, refusing any version other than 22 so stale migrations never serve names, and distinguishing `busy` from `unavailable` (#T("Sources/IMsgCore/AddressBookContacts.swift:17-18,46,56-63")).

  *Matching heuristics are minimal:* phone numbers through PhoneNumberKit to E.164 per region, otherwise the input is returned unchanged (#T("Sources/IMsgCore/PhoneNumberNormalizer.swift:7-14")); email lowercased; chat-guid prefixes (`iMessage;-;`, `SMS;+;`, `any;-;` and so on) stripped before lookup (#T("Sources/IMsgCore/ContactCatalog.swift:244-251")); first contact wins on a collision (#T("Sources/IMsgCore/ContactCatalog.swift:212,215")); name search is a case-insensitive substring returning the first phone or email (#T("Sources/IMsgCore/ContactCatalog.swift:73-90")). Sender fallback to `destination_caller_id` when the handle is empty (#T("Sources/IMsgCore/MessageStore+Messages.swift:390-393")). No persistent identity, no slugs, no merge across handles.],
  [Three explicit normal forms (MATCH, KEY, SEND) with golden pins and a documented slug-stability constraint (#O("src/handle-normal.ts:1-31")), contact ranking (`contact-rank.ts`), vCard comparison, persistent slugs (`slug-store.ts`, `thread-slug.ts`). Contacts are read from our own `contacts-db.ts`.],
  [#HAVE on identity and matching; theirs is deliberately simple. #ADOPT only two operational ideas: the authorization state machine with "last good catalog" semantics, and the headless "never prompt" policy. #ADAPT their AddressBook version gate (refuse versions other than the one validated) if we read AddressBook directly.],
  [`packages/apple/contacts` (proposed, small) for the catalog refresh/auth state machine, only if `contacts-db.ts` is extracted. Otherwise a note in `contacts-db.ts`. No change to `handle-normal.ts`.],
)

#area(
  "Send pipeline: AppleScript and private API, retries, error detection",
  [Two transports. *AppleScript* via `/usr/bin/osascript -l AppleScript -` with the script on stdin and arguments in argv; stdout/stderr captured to 0600 files in a 0700 temp dir; hard timeout of 150 s (#T("Sources/IMsgCore/AppleScriptSendTransport.swift:8-84"), #T("Sources/IMsgCore/IMsgBridgeProtocol.swift:30")). The script tracks `dispatchPhase` (`pre_dispatch` then `dispatch_started`) and always returns `IMSG_RESULT<TAB>ok|failure<TAB>phase<TAB>errno`; a missing or malformed result line is conservatively `mayHaveCompleted` (#T("Sources/IMsgCore/MessageSender.swift:210-275"), #T("Sources/IMsgCore/AppleScriptSendTransport.swift:86-106")). *Injected bridge* via IMCore private APIs through a file queue (v2: atomic `<uuid>.tmp` rename into `in/`, response in `out/`; v1 was a single overwritten file that raced) (#T("Sources/IMsgCore/IMsgBridgeProtocol.swift:3-11")).

  Routing: attachments are staged by copying into `~/Library/Messages/Attachments/imsg/<uuid>/` through the safe-open path (#T("Sources/IMsgCore/MessageSender.swift:123-166")). SMS fallback is allowed only when the user asked for `auto`, the target is a phone number, the message is text-only, *and* the failure is `retrySafe` (#T("Sources/IMsgCore/MessageSender.swift:99-106,196-198")). Failure classification funnels through one classifier that maps pre-publication errors to `notStarted` and post-publication errors to `mayHaveCompleted` for mutations (#T("Sources/IMsgCore/BridgeFailureClassifier.swift:4-34")). Mutations are never retried implicitly: `isMutation` is a property of the action enum (#T("Sources/IMsgCore/IMsgBridgeProtocol.swift:99-107")). Verification after send reads chat.db for a matching sent row (`SentMessageVerifier.swift`, 155 lines, not read in detail; and #T("Sources/IMsgCore/MessageStore+AttachmentReceipts.swift:5-46") for attachments by staged path).],
  [`execFile("osascript", ["-e", script])` with 30 s timeout, stderr redacted before logging (#O("src/applescript.ts:72-83")); delivery truth derived afterwards from `error`, `is_sent`, `is_finished`, `was_downgraded` (#O("src/delivery-status.ts:1-40")). No retry-safety notion. I found no `dispatchPhase`-style signal in `applescript.ts`.],
  [#ADOPT the phase protocol and the `Disposition` vocabulary; keep our chat.db delivery-truth derivation as the *second* stage. #SKIP the injected bridge (requires SIP disabled, #T("README.md:89")). The 150 s timeout is empirically derived for macOS 26 (#T("Sources/IMsgCore/IMsgBridgeProtocol.swift:28-30")); our 30 s is likely too short on that OS, so *verify before copying the number*.],
  [`packages/apple/send` (proposed): `script.applescript` as a string constant with the phase protocol, `interpret(stdout) -> Result`, `Disposition` type, `retrySafe` getter; `apps/imsg-mcp` send tool surfaces the disposition in `structuredContent`. Pair with the mcp-kit mutation lane (next area).],
)

#area(
  "Watching for new messages: FSEvents versus polling",
  [`DispatchSource` vnode sources (kqueue, not FSEvents) on three files, `chat.db`, `-wal` and `-shm`, plus one on the directory, each with an inode/device identity so a replaced file is re-armed (#T("Sources/IMsgCore/MessageWatcher.swift:106-116,168-170,186-215")). Events are debounced 0.25 s, with a 5 s fallback poll that also refreshes registrations (#T("Sources/IMsgCore/MessageWatcher.swift:7-31,243-266")). The cursor is a `ROWID` high-water mark, never file state; each poll drains in bounded batches (default 100) and re-schedules itself while the cursor advances (#T("Sources/IMsgCore/MessageWatcher.swift:268-315")). Output is an `AsyncThrowingStream` with `bufferingOldest(256)`; a dropped yield ends the stream with `MessageWatcherOverflowError(resumeAfterRowID:)` so the client can resume with no gap (#T("Sources/IMsgCore/MessageWatcher.swift:38-44,66,292-298")). A message row without a resolved chat is retried up to 20 times then skipped (#T("Sources/IMsgCore/MessageWatcher.swift:335-353")). URL-preview rows are de-duplicated with a 90 s window and 10 minute retention (#T("Sources/IMsgCore/MessageStore.swift:89-125")). Helper events are tailed from a JSONL file with rotation handling (#T("Sources/IMsgCore/IMsgEventTailer.swift:35-39")).],
  [Wal file watch, directory watch, 10 s safety poll, 150 ms debounce, `maxBatch` pages, never throws into the host, documented live finding that the directory watch alone delivered nothing on the real Messages directory (#O("src/change-watcher.ts:1-38")).],
  [#HAVE overall, and our write-up of the TCC/FSEvents blind spot is better evidence than theirs. #ADOPT three details: watch `-shm` too, overflow-with-resume-cursor for any bounded subscriber stream, and the unresolved-chat retry (verify we have an equivalent; I did not find one).],
  [`packages/apple/chatdb/watch.ts` once the watcher is extracted from `change-watcher.ts`; the resume-cursor error type belongs in the shared event contract used by `wait_for_changes`.],
)

#area(
  "Media: transcription, OCR, conversion, caching",
  [#NOFIND: OCR, speech recognition, vision captioning, any model call. Media handling is limited to (1) reading Apple's stored transcript, (2) optional ffmpeg conversion for CAF and GIF (#T("docs/attachments.md:36-52")), (3) `afconvert` for outgoing voice notes (#T("Sources/IMsgCore/AudioMessagePreparer.swift:42-56")), (4) ImageIO validation of stickers (#T("Sources/IMsgCore/StickerAsset.swift:1-60")), (5) `LinkPresentation` for rich-link metadata on send (#T("Sources/imsg/RichLinkPreparer+LinkPresentation.swift:30")). Converter processes are bounded by the 60 s `ProcessTimeout` (#T("Sources/IMsgCore/AttachmentResolver.swift:129,131-147")).],
  [`media-intel*.ts`, `media-providers.ts`, `media.ts`: provider chain, cache, runtime; zero-dependency `sips`/`qlmanage`/`mdls`/`afinfo` helpers (#O("src/media.ts:1-17")).],
  [Nothing to copy for engines or caching. #ADOPT only the conversion stage mechanics (lesson 5) and the process controls (lesson 10). Engine design must come from R2/L, not from this repo.],
  [`packages/media/intel/convert/` (stage), `packages/os/proc` (proposed, tiny: `runBounded(argv, {timeoutMs, killGroup})`).],
)

#area(
  "Caching and persistence",
  [Only on-disk state in `IMsgCore` is the conversion cache under `Library/Caches/imsg/converted-attachments` (#T("Sources/IMsgCore/AttachmentResolver.swift:176-184")), staged send copies under `Library/Messages/Attachments/imsg/` which are explicitly *not* pruned (#T("docs/attachments.md:66")), and in-process caches: reply-parent memo keyed by guid that caches misses as well as hits (#T("Sources/IMsgCore/MessageStore+ReplyContext.swift:4-16")), poll option text cache, contact snapshots. No database of its own, no logs on disk (stderr only; a `verbose` flag, #T("Sources/imsg/RuntimeOptions.swift:5-10")). Persistent slugs and identities: unknown/none.],
  [`slugs.db`, interpretation cache (`media-intel-cache.ts`, 183 lines), analytics cache, structured logging to files (logger.ts).],
  [#HAVE. One transferable micro-idea: *negative caching* of lookups that failed, scoped to one query loop (#T("Sources/IMsgCore/MessageStore+ReplyContext.swift:12-15")). Do not apply it to interpretation results.],
  [No new package. Note in `media-intel` v2 design that failures need their own `status` and TTL, not negative-by-omission.],
)

#area(
  "Concurrency model",
  [Swift 6 strict concurrency. Data access: serial queues. RPC: an actor `RPCScheduler` with *three lanes*: all mutations run through one FIFO worker; reads run up to four in parallel; control requests have their own worker; admission limited to 128 outstanding requests (#T("Sources/imsg/RPCServer+Runtime.swift:23-70")). A mutation includes validation, staging, bridge call, the response and post-send verification before the next mutation starts (#T("docs/rpc.md:101-106")). If a mutation ends `stillInFlight`, the lane is *poisoned*: queued and future mutations are rejected with `mutationLaneBlocked` until restart (#T("Sources/imsg/RPCServer+Runtime.swift:126-141")). Launch of Messages.app is guarded by a serial coordinator plus a cross-process lock file whose path is checked for symlinks (#T("Sources/IMsgCore/BridgeLaunchCoordinator.swift:7-80")). Stdin is read by one dedicated thread (#T("Sources/imsg/RPCServer+Runtime.swift:7-20")).],
  [Node single thread; `node:sqlite` synchronous; watchdog (`watchdog.ts`), event bus, shutdown registry (`shutdown.ts`). No lane concept: unknown whether concurrent MCP `send_message` calls are serialised.],
  [#ADOPT the *mutation lane* and poison-on-ambiguous-failure: two concurrent sends from an agent loop are the realistic duplicate-send risk. Reads need no cap beyond what the host already imposes.],
  [`mcp-kit` v3 dispatcher option `lane: "mutation" | "read" | "control"` declared in the descriptor (lesson 2); the poison signal is raised by `packages/apple/send` (previous area).],
)

#area(
  "Error-handling types",
  [A closed `IMsgError` enum with user-oriented descriptions (#T("Sources/IMsgCore/Errors.swift:3-13")); `DeliveryFailure` for mutations (#T("Sources/IMsgCore/DeliveryFailure.swift:24-67")), which sanitises detail to one line and 512 characters (#T("Sources/IMsgCore/DeliveryFailure.swift:58-66")); separate typed errors for the launcher, tailer, stickers and polls. The RPC boundary maps errors with one function: caller-caused (`invalidISODate`, `invalidChatTarget` ...) become JSON-RPC `invalidParams`, everything else `internalError`; `DeliveryFailure` has its own error shape (#T("Sources/imsg/RPCServer+Dispatch.swift:107-131,160-169")). Cancellation is swallowed quietly (#T("Sources/imsg/RPCServer+Dispatch.swift:107")). Warning: the rule "callers must never infer retry safety by matching description" is written into the type's doc comment (#T("Sources/IMsgCore/DeliveryFailure.swift:20-23")).],
  [Mixed `Error`/string errors; MCP errors wrapped by home-made dispatchers (plan item 1). Results for interpretation lack a closed status type (plan item 3).],
  [#ADOPT the two-class mapping (caller-caused vs internal) at the single tool boundary, and the "typed field, never string matching" rule. It is the same discipline the plan's `InterpretResult (ok | refused | failed | unsupported)` needs.],
  [`mcp-kit` v3: `ToolError` with `kind: "invalid_params" | "internal" | "delivery"` and `retrySafe?`. `packages/media/intel`: `InterpretResult` as planned.],
)

#area(
  "Testing and fixtures: how they fake chat.db",
  [Swift Testing (`@Test`), 816 cases (counted by `grep -c`). Fixtures are *built in code*: an in-memory SQLite connection with `CREATE TABLE` statements parameterised by a `SchemaOptions` struct that toggles optional columns (attributedBody, reaction columns, audio flag, balloon, payload data, scheduled, read state, chat routing), emulating older macOS schemas (#T("Tests/IMsgCoreTests/MessageDatabaseFixture.swift:25-48")). The store has a test initialiser that accepts the capability flags directly (#T("Sources/IMsgCore/MessageStore.swift:36-77")). Every external effect is an injected closure on `RPCServer` (send, bridge invoke, stagers, clock, stream providers) (#T("Sources/imsg/RPCServer.swift:50-120")), so RPC tests drive `handleLineForTesting` with raw JSON strings, including a battery of malformed-parameter requests that must each yield `-32602` (#T("Tests/imsgTests/RPCContractValidationTests.swift:7-60")). Native tests for the Obj-C helper compile real fragments into small host binaries (#T("Makefile:32-47")). Binary fixtures are synthetic and documented (a 0.5 s 440 Hz tone stored as base64, #T("Tests/IMsgCoreTests/Fixtures/README.md:1-12")). A Linux CI job runs the read-core tests plus a standalone-archive smoke test in a bare Ubuntu container (#T("scripts/check-linux.sh:11-32"), #T("TestsLinux/LinuxReadCoreTests.swift")); the docs tell users to copy a live database with SQLite's `.backup` rather than `cp` (#T("docs/linux.md:47-53")).

  *Weakness shared with us:* fixtures use nanosecond dates and always populate `mime_type` (#T("Tests/imsgTests/CommandTestDatabase.swift:7-10,41-50")), so their fixtures too could not catch a seconds-vs-nanoseconds or null-MIME bug.],
  [`scripts/generate-fixtures.ts` generates a file DB with nanosecond `created_date`, no null-MIME rows and no plugin payloads (plan item 9, citing `scripts/generate-fixtures.ts:702-806`).],
  [#ADOPT the *`SchemaOptions` matrix*: generate each fixture under several column-presence profiles and run the same assertions; and the malformed-parameter battery for tool schemas. Add what neither repo has: realistic-value rows (seconds `created_date`, null MIME, plugin payloads). #ADOPT differential testing against their built `imsg` binary on our synthetic fixture as an *oracle for decoding* (optional, see Reuse).],
  [`packages/apple/chatdb/testing/fixture.ts` (`buildFixture(profile)`), shared by imsg-mcp tests and the media packages.],
)

#area(
  "Packaging and distribution: signing, notarisation, Homebrew",
  [One version source `version.env` (#T("version.env:1")) generates `Version.swift`, `Info.plist` and a C header (#T("scripts/generate-version.sh:1-30")). `scripts/build-universal.sh` builds per-arch with `swift build --arch`, merges with `lipo`, builds the dylib with a required slice list (`arm64e arm64 x86_64`, failing if one is missing because macOS 26 silently refuses an arm64-only dylib), and signs with the Developer ID identity using `--timestamp --options runtime` and explicit `--identifier` (#T("scripts/build-universal.sh:11-16,37-78")). Ad-hoc signing (`-`) for dev. Entitlements: Apple Events and Address Book only (#T("Resources/imsg.entitlements:5-8")). The CLI embeds an `Info.plist` into the binary at link time via `-sectcreate __TEXT __info_plist`, giving a bare executable a bundle identifier and the `NSAppleEventsUsageDescription` / `NSContactsUsageDescription` strings, which is what lets TCC prompts name it (#T("Package.swift:46-51"), #T("Sources/imsg/Resources/Info.plist:1-20")). Releases use a shared reusable workflow `openclaw/release-workflows@v1` with notarisation, checksum inventory, independent verifier jobs and a Homebrew tap handoff (#T("docs/RELEASING.md:3-22")). A Linux static-runtime tarball is built too. CI pins action SHAs and runs lint, tests, a no-send native probe and a build (#T(".github/workflows/ci.yml:16-60")). Vendored-dependency patching is scripted (#T("scripts/patch-deps.sh:1-30")).],
  [npm package built by Vite; Rust `.node` addon prebuilt for darwin-arm64 only (#O("native/imsg-native.darwin-arm64.node")); `manifest.json` for MCPB; release by multi-semantic-release (repo `CLAUDE.md`).],
  [#ADOPT the recipe for `packages/apple/intel`: `-sectcreate` Info.plist for TCC identity (Speech Recognition and Vision usage strings are required for the permission prompts), `lipo` universal, `codesign --options runtime --identifier`, a build step that *asserts* required slices. #SKIP Homebrew/Linux for now; we ship through npm and MCPB.],
  [`packages/apple/intel/` (Swift, per plan) with `scripts/build.sh`, `Resources/Info.plist`, `Resources/intel.entitlements`; notarisation is out of scope until a distribution decision is made (unknown requirement).],
)

#area(
  "MCP layer: schema generation and JSON Schema dialect",
  [#NOFIND for MCP and JSON Schema. The contract is JSON-RPC 2.0 over stdio with hand-maintained docs tables (#T("docs/json.md:1-40"), #T("docs/rpc.md:1-60")). Parameters are parsed from `[String: Any]` by a hand-written accessor that (a) rejects any key not in the method's supported set, (b) is type-strict (a string "2" is not an integer, `true` is not 1, #T("Sources/imsg/RPCParameters.swift:18-51"), #T("docs/rpc.md:22-26")), (c) allows only *explicit, per-method* aliases (#T("docs/rpc.md:28-44")), and (d) requires exactly one of `chat_id | chat_identifier | chat_guid` (#T("Sources/imsg/RPCParameters.swift:85-91")). A `status`/`initialize` response advertises `rpcUsableMethods` filtered by live database and bridge capability (#T("Sources/imsg/RPCServer+StatusHandlers.swift:140")). Descriptor table: #T("Sources/imsg/RPCMethodDescriptors.swift:107-223"). No output schemas exist; outputs are dictionaries built by hand (#T("Sources/imsg/OutputModels.swift:1-60"), not read in full: unknown whether any are `Codable` structs).],
  [Two hand-written definitions per tool (JSON in `mcp-tools.ts`, zod in `mcp-schemas.ts`), three zod-to-JSON converters across repos, draft-07 output rejected by a client update (plan "Context" and item 1).],
  [Nothing about dialects. #ADOPT only the *behavioural contract*: fail-closed unknown keys, strict types, explicit aliases, mutually-exclusive selector groups expressed in the schema (`oneOf` with `required`), capability-gated listing. In zod 4 this is `z.strictObject` plus `z.xor`-style refinements, emitted to 2020-12 by the kit converter.],
  [`@george43g/mcp-kit` v3: `defineTool({ name, aliases, input, output, lane, requires: { db: [...], bridge: [...] } })`; `listTools(caps)` filters on `requires`; conformance helper includes a "reject unknown key" case per tool.],
)

= Their structure to our packages

#figure(
  diagram(
    node-stroke: 0.6pt,
    node-inset: 5pt,
    spacing: (36mm, 7mm),
    node((0, 0), [`MessageStoreSchema` + \ `MessageRowSelection` + \ `decodeMessageRow`], name: <a1>, fill: green.lighten(85%)),
    node((0, 1), [`appleEpoch` / `appleDate` + \ `MessageFilter.fromISO`], name: <a2>, fill: green.lighten(85%)),
    node((0, 2), [`conversionPlan` + sha cache + \ `audio-transcription` plist], name: <a3>, fill: green.lighten(85%)),
    node((0, 3), [`balloon_bundle_id` + \ URL-preview coalescing], name: <a4>, fill: green.lighten(85%)),
    node((0, 4), [`RPCMethodDescriptor` + \ `RPCParameters` + `RPCScheduler`], name: <a5>, fill: green.lighten(85%)),
    node((0, 5), [`DeliveryFailure` + \ AppleScript `dispatchPhase`], name: <a6>, fill: green.lighten(85%)),
    node((0, 6), [`MessageWatcher` + \ `TypedStreamParser`], name: <a7>, fill: green.lighten(85%)),
    node((0, 7), [`ProcessTimeout` + `SecurePath` + \ `AttachmentSource`], name: <a8>, fill: green.lighten(85%)),
    node((0, 8), [`Package.swift` `-sectcreate` + \ `build-universal.sh` + entitlements], name: <a9>, fill: green.lighten(85%)),

    node((2, 0), [`packages/apple/chatdb` *(new)* \ schema, rows, queries, decode, watch], name: <b1>, fill: blue.lighten(85%)),
    node((2, 1.5), [`packages/time/apple` + \ `packages/time/user-date`], name: <b2>, fill: blue.lighten(85%)),
    node((2, 3), [`packages/media/kind` + \ `packages/media/intel`], name: <b3>, fill: blue.lighten(85%)),
    node((2, 4.4), [`mcp-kit` v3], name: <b5>, fill: blue.lighten(85%)),
    node((2, 5.5), [`packages/apple/send` *(new)*], name: <b6>, fill: blue.lighten(85%)),
    node((2, 7), [`packages/os/proc` *(new, tiny)*], name: <b8>, fill: blue.lighten(85%)),
    node((2, 8), [`packages/apple/intel` (Swift helper)], name: <b9>, fill: blue.lighten(85%)),

    edge(<a1>, <b1>, "->"),
    edge(<a2>, <b2>, "->"),
    edge(<a3>, <b3>, "->"),
    edge(<a3>, <b1>, "->", stroke: (dash: "dashed")),
    edge(<a4>, <b3>, "->"),
    edge(<a4>, <b1>, "->", stroke: (dash: "dashed")),
    edge(<a5>, <b5>, "->"),
    edge(<a6>, <b6>, "->"),
    edge(<a6>, <b5>, "->", stroke: (dash: "dashed")),
    edge(<a7>, <b1>, "->"),
    edge(<a8>, <b8>, "->"),
    edge(<a9>, <b9>, "->"),
  ),
  caption: [Mapping from openclaw/imsg structures (left, green) to our target packages (right, blue). Dashed edges are secondary destinations. The three packages marked *new* are proposals beyond the plan's table (`apple/chatdb`, `apple/send`, `os/proc`); `time/*`, `media/*`, `mcp-kit` and `apple/intel` are already in the plan.],
)

*Why a new `packages/apple/chatdb`.* The plan's package table (`time/*`, `media/*`) removes date, MIME and filter logic from `imessage-db.ts` but explicitly does not rewrite it (plan item 10). The strongest structural lesson in this repo (lesson 1) is the one the plan defers. A `chatdb` package would be the landing place for the schema probe, row selection and decode, query objects and the watcher, and it is also what the fixture builder (lesson in testing) needs to share with the media packages. I recommend adding it to the plan as a *non-blocking* parallel track after F, because B (data-access correctness) otherwise keeps editing the same 2892-line file.

= Reuse candidates and licence

#table(
  columns: (3.2cm, 1fr, 2.6cm),
  stroke: 0.4pt + luma(170),
  inset: 5pt,
  table.header([*Candidate*], [*Assessment*], [*Verdict*]),
  [Vision OCR or Speech helper],
  [#NOFIND. There is no Swift code that calls Vision, Speech, SFSpeechRecognizer or SpeechAnalyzer (search described in the summary). `packages/apple/intel` must be written from scratch; only its *build and signing recipe* can be borrowed.],
  [No component to reuse],
  [`imsg rpc` as a sidecar],
  [A ready JSON-RPC-over-stdio reader/sender (`imsg rpc`, supervised as a child that exits when stdin closes, #T("docs/rpc.md:99")). Pros: mature read/watch/send semantics, typed delivery failures. Cons: version 0.15.10 pre-1.0 with fast churn (441 commits between 2025-12-05 and 2026-10-06 per `git log` of the clone; version in #T("version.env:1")), requires macOS 14+ and a Swift 6 toolchain to build (#T("Package.swift:6")), overlaps our Rust native addon, and adds a second runtime to a package that ships as MCPB. Not a fit as a dependency.],
  [*Study, do not depend.* Use as a decoding oracle in tests only],
  [`IMsgCore` as a SwiftPM library],
  [Reusable only from Swift. Our native helper boundary is Swift for Apple frameworks (Speech, Vision), not for chat.db, which we already read in TypeScript and Rust. Linking it would pull in PhoneNumberKit and SQLite.swift for no gain.],
  [Skip],
  [Small algorithms to re-implement],
  [`TypedStreamParser` (63 lines), `AudioMessagePreparer` argv and post-check, `AttachmentResolver.conversionPlan`, `ProcessTimeout.terminate`, `SecurePath.hasSymlinkComponent`, AddressBook v22 query, `DeliveryFailure` vocabulary, the `IMSG_RESULT` protocol. All are short, self-contained, and described above.],
  [Re-implement from the description; add attribution comments],
  [Injected IMCore dylib (`Sources/IMsgHelper`, 7,280 lines Obj-C)],
  [Needs SIP disabled for system-app injection, private selectors that vary by macOS release, arm64e slice, and may still be blocked by library validation (#T("README.md:89"), #T("Sources/IMsgHelper/README.md:5")). Unacceptable for a tool that reads private message data and ships to other users.],
  [Reject. R1a may still weigh the *features* it enables (typing, read receipts, edit/unsend)],
  [Build, sign and Info.plist recipe],
  [Directly reusable pattern for `packages/apple/intel` (lesson 10).],
  [Adopt the recipe],
)

== Licence verdict

*openclaw/imsg is MIT*, `Copyright (c) 2026 Peter Steinberger` (#T("LICENSE:1-3")). Our `apps/imsg-mcp` is also MIT, `Copyright (c) 2026 George G` (#O("LICENSE:1-3"), and `"license": "MIT"` in `package.json:96`). Studying, re-implementing algorithms and even copying code are permitted. MIT's condition is that the copyright and permission notice accompany "all copies or substantial portions", so:

- *Re-implementation from the described algorithm* in TypeScript: no notice obligation in practice, but I recommend a one-line provenance comment ("approach from openclaw/imsg, MIT") at each site.
- *Verbatim or near-verbatim transliteration of non-trivial code* (for example the AppleScript source, or `TypedStreamParser`): add a `THIRD_PARTY_NOTICES` entry with the MIT text and copyright line.
- *Dependencies* of theirs (relevant only if we ever link or fork): Commander MIT, SQLite.swift MIT, PhoneNumberKit MIT (GitHub licence API, queried 2026-10-08). CSQLite returned *no SPDX licence* from the API: unknown, would need a manual check before any use.
- This is an engineering reading of the licence, not legal advice.

= Risks

+ *Misreading the subject.* The brief assumed a media and MCP layer; there is none. Any plan item that says "do it the way openclaw/imsg does" for interpretation, cache provenance or schema dialect has no source. Mitigation: rely on R2/L/R3 for engines and on the kit work for schemas.
+ *Copying their unit assumption.* Taking `appleEpoch` as written would reintroduce our `attach-search-date-units` bug (nanoseconds applied to `attachment.created_date`). Mitigation: branded units and a per-column unit table.
+ *Typedstream "strict" path may misparse some layouts.* It scans for the first `01 2b`. Mitigation: dual-parser differential test before switching the default.
+ *`user_info` coverage is unverified.* I did not read any real database. Whether the `audio-transcription` key is populated on gmac's macOS 15.7, and whether it agrees with the `IMAudioTranscription` attribute, is unknown. A count-only schema query (`SELECT COUNT(*) FROM attachment WHERE user_info IS NOT NULL`) would settle presence without reading content.
+ *Timeout numbers are OS-specific.* 150 s send timeout is derived for macOS 26 (#T("Sources/IMsgCore/IMsgBridgeProtocol.swift:28-30")); our host is 15.7.
+ *Upstream churn.* 441 commits since 2025-12-05 and breaking-looking features (polls, scheduled sends); anything we mirror should be mirrored as an idea, not a dependency.
+ *Package proliferation.* Proposing three new packages (`apple/chatdb`, `apple/send`, `os/proc`) adds workspace surface. `os/proc` could instead live inside `media/intel` until a second consumer appears.

= Unknowns (not verified)

- Whether `SentMessageVerifier.swift` (155 lines) and `RichLinkPreparer.swift` (356 lines) contain additional transferable algorithms; I read only their callers.
- Whether `OutputModels.swift` defines `Codable` output structs that would count as a typed output contract.
- Whether our `change-watcher.ts` already handles a message row that precedes its `chat_message_join` row (no match for "unresolved" in the file).
- Whether `node:sqlite` can open with `mode=ro` URI semantics.
- The exact scope of `DurationParser.swift` and any relative-date support in their CLI.
- Poll decoding (`MessagePollDecoder`, `PollKeyedArchiveResolver`) uses a cycle- and depth-limited NSKeyedArchiver graph walk (#T("Sources/IMsgCore/PollKeyedArchiveResolver.swift:3-30")); it is a feature area for R1a, and I did not evaluate whether a Node bplist reader suffices for our own `payload_data` needs.
- Nothing here was run: no build of their binary, no execution against any database. All findings are from reading source at the pinned SHA.
