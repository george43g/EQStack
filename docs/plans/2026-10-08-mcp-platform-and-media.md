# MCP schema platform + imsg media & attachment correctness (plan, 2026-10-08)

Approved by George 2026-10-08. Bugs live in the HANDOFF §10a ledger; this file is the plan they're fixed under. Machine-local working copy: `~/.claude/plans/glowing-percolating-key.md`.

## Context

Four reports converge on the same few structural causes:
- **A Claude Code update broke our tools.** It rejects draft-07 schemas. Hotfix #184 strips the label, but every server still produces draft-07.
- **A Claude Desktop agent summarising one real thread hit three problems:**
  - Every `.caf` voice memo "transcript" is a cached LLM refusal ("you didn't attach an audio file").
  - Screenshot interpretations are one-line captions, and they get the speakers backwards.
  - Cached interpretations don't appear in `get_messages`.
- **Our own fork found:**
  - five `search_attachments` bugs;
  - multi-attachment messages that show only one caption.

George wants these fixed at the root, not patched. Where a bug comes from a structural choice, this plan names the choice and fixes that.

The parked GC-1 workstream stays parked. Its state is in the HANDOFF checkpoint `4fd468b`, so nothing is lost.

**George's decisions (2026-10-08, the ask-each-question round):**
1. **Framework:** imsg and gmail move fully onto mcp-kit v3.
2. **Kit owner:** the `mcp-starter-template` session builds kit v3 from my spec.
3. **Media engine:** both local tools and OpenRouter can be configured at once, with a preference order, a switchable default and a per-call choice. Local transcribers are installed, documented and supported. Routing picks the engine by content difficulty, and preprocessing cleans up and **compresses** media before any upload. Re-running all or part of a contact's export with newer models or settings is a first-class command. All of this is easy to discover in the TUI, CLI and MCP. A native Swift or Rust helper is fine, and it lives in packages.
4. **Sequencing:** **research first, then build.** No imsg structural change until the openclaw/imsg report and the landscape research are triaged by George.
5. **Kit work runs during research:** K, T and G go ahead in parallel with it.

He also wants more of each app moved into small self-contained packages under `packages/<category>/<name>`. They may depend on each other and need not be published.

## What's structurally wrong (the findings George asked for)

Every claim below is verified in code, with `file:line` in the explorer reports summarised here.

1. **Three home-made MCP server frameworks.**
   - imsg, gmail and mcp-kit (which telephony uses) each have their own tool registry, zod→JSON-Schema converter, timeout and dispatcher, and error/prompt-injection wrapper.
   - imsg and gmail don't use mcp-kit at all, and imsg's `sanitize`/`prompt-injection` are copies of mcp-kit's.
   - imsg keeps **two hand-written input definitions per tool**: JSON at `mcp-tools.ts`, plus zod in `mcp-schemas.ts` (24 tools, with nothing checking they agree).
   - gmail returns `structuredContent` but never advertises an `outputSchema`.
   - The draft-07 break is a symptom of this: there are three converters, so there were three places to fix.
2. **zod 3 + `zod-to-json-schema` can't produce 2020-12.**
   - zod 3.25.76 contains `zod/v4`'s `toJSONSchema` (draft-2020-12, with `io: input|output`). But it only accepts zod-4 schemas.
   - So real 2020-12 output **requires migrating schemas to zod 4**. Migration size: imsg is small; gmail and telephony are medium (`.passthrough`, `.strict`, `ZodTypeAny`).
3. **media-intel treats "a string came back" as success** (`media-intel.ts:264-278`).
   - No result type separates a transcript from a refusal, so refusals are cached as `done` forever.
   - `force` can't evict a `done` row (`:222-233`), and there's no MCP purge.
4. **Providers have no per-format capability and there's no conversion stage.**
   - CAF bytes go out labelled `m4a` (`media-providers.ts:141-148`), through the **vision** model (`media-intel.ts:380`; there's no `models.audio` slot).
   - PNG goes out labelled `image/jpeg` (`media-providers.ts:215`).
   - **No local transcriber is installed on gmac** (`yap`, `whisper-cli` and `hear` are all missing), so the default `["apple","local"]` chain does nothing locally and every memo falls to the paid cloud.
5. **One interpretation slot per message.**
   - Enforced in three places: `types.ts:129`, `mcp-schemas.ts:88`, and the `break`s in `media-intel-runtime.ts:197,231`.
   - Inlining is wired into `get_messages` only (`index.ts:654`). search, unread and events skip it; export has its own path.
6. **The cache has no provenance.** There's no prompt, model or pipeline version (`media-intel-cache.ts:39-62`), so a better prompt can never invalidate old answers.
7. **Dates have no type that records their unit.**
   - There are about 8 scattered Apple-epoch conversions, and `db-schema.ts:10` says wrongly that every timestamp is in nanoseconds. That's the cause of bug `attach-search-date-units`.
   - The one user-date parser rejects ISO with seconds or `Z` and builds local time (`date-parse.ts:29-37`), and a handler then drops the unparsed value silently (`index.ts:1855`).
8. **MIME/kind classification is copied about 5 times, and attachment filter SQL twice.** The copies disagree, which causes the `.caf` null-MIME and plugin-payload bugs.
9. **Fixtures don't look like real data.** They have nanosecond `created_date`, no null-MIME rows and no plugin payloads (`scripts/generate-fixtures.ts:702-806`). That's why bugs 1, 4 and 5 passed CI.
10. **A god file.** `imessage-db.ts` is 2892 lines in one class, with three hand-written attachment queries. Not rewritten here; the shared modules below take its date, MIME and filter logic out.

## Target shape (shared code lives in packages)

- Add `packages/*/*` to `pnpm-workspace.yaml` so packages can be grouped in category directories.
- New private `@eqstack/*` packages, consumed as **devDependencies** and inlined by imsg's Vite build (`vite.config.ts` externalises only an explicit list).
  - Why devDependencies: a `workspace:*` runtime dependency on a private package would make npm install of the published `imsg-mcp` fail.

| Package | Purpose | Replaces |
|---|---|---|
| `packages/time/apple` → `@eqstack/apple-time` | Branded `AppleNanos`/`AppleSeconds`/`Date` conversions; one place that knows each column's unit | about 8 scattered conversions (`db-schema.ts`, `imessage-db.ts:180,2372,2470`, `edit-history.ts`, `mock-send-db.ts`, the fixture generator) |
| `packages/time/user-date` → `@eqstack/user-date` | Strict user-date grammar (ISO with seconds, `Z` and offsets; relative phrases); returns `Result`, never a silent `null` | `date-parse.ts` |
| `packages/media/kind` → `@eqstack/media-kind` | MIME/UTI/extension → `{kind, mime}` inference; plugin-payload and sticker predicates; one SQL filter fragment | 5 copies of `kindFromMime`, `audioFormat`, the two TUI copies, `imessage-db.ts:2459,2548` |
| `packages/media/intel` → `@eqstack/media-intel` | The interpretation engine: typed results, provider capabilities per format, conversion stage, validation, cache v2 with provenance, local Apple engines | `apps/imsg-mcp/src/media-intel*.ts`, `media-providers.ts`, `media.ts` (and its dead `transcribeAudio*` at `:226-292`) |
| `@george43g/mcp-kit` **v3** (upstream, `~/repos/mcp-cli-starter-template/packages/mcp-kit`) | zod 4; one `toMcpSchema(schema, io)` → JSON Schema 2020-12 (refs inlined, top-level object asserted); a registry that derives the input **and** output schema from one zod definition; an exported conformance helper (Ajv2020 strict compile + `structuredContent` against `outputSchema`) | the three converters, the three registries and dispatchers, and the #184 strip hacks |

## Wave 0: park and prepare (me, before any agent starts)

- Refresh the eqstack HANDOFF checkpoint. GC-1 stays parked with its Resume line intact, plus one line pointing at this plan.
- Claim ledger rows.
- ACK `mcp-starter-template`'s tui-kit 0.6.0 note. The bump and ctrl-e/y are folded into wave 2's TUI work.
- Check `codexbar` before fanning out agents.

## Wave 1: research (gates all imsg structure work) plus the kit lane

Run in parallel, each as a read-only researcher unless it writes a report. Reports go in `docs/research/2026-10-openclaw/`: Typst sources plus compiled PDF, with diagrams. The research agents choose the diagram tools on gmac (Typst is on PATH via mise; check for others).

- **R1a — openclaw/imsg: features and UX.** Clone to scratch. Inventory every feature, command, MCP tool and config surface. Compare each with imsg-mcp: we have it, better or worse; we lack it. Triage into adopt-now / adopt-later / skip, with a reason for each.
- **R1b — openclaw/imsg: structure and algorithms.** Data model (chat.db access, attachments and MIME, dates), contact and identity resolution, media handling, caching, concurrency, error handling, packaging. Name each algorithm or structure worth copying, with `file:line` in their repo and where it would land in our packages.
- **R2 — landscape notebooks (NotebookLM MCP).** One notebook on **iMessage tooling**: OSS iMessage MCPs and CLIs, analytics tools, and personal-contact managers (Dex, plus the other George remembers; the agent surveys Clay, Monica, Folk and others to find it). One notebook on **every other messenger**: WhatsApp, Signal, Telegram, Messenger and Slack bridges, MCPs and APIs (Beeper/Matrix bridges and so on). Output: the notebooks, plus a ranked findings summary.
- **R3 — openclaw org crawl** (`github.com/orgs/openclaw/repositories`). Triage every repo with a focus on messenger MCPs. For each interesting one, recommend: vendor as a library, wrap thinly, write a skill or script around it, or just study it. Includes the Rust-based bun fork, for the runtime-migration backlog item. Typst report with diagrams.
- **L — local engines on gmac.** Install and verify the local transcribers and OCR tools that run on macOS 15.7: `hear` (SFSpeechRecognizer) and whisper.cpp plus a model. Record that `yap` needs macOS 26's SpeechAnalyzer and isn't usable here. Each is verified on a synthetic sample, never personal media. This is environment setup, not imsg code. Notes go to the imsg docs as a draft for wave 2.
- **K → T, G — schema platform lane.** Exactly as specified below. imsg is not touched in wave 1.

**Gate (George):** read R1a, R1b, R2 and R3, triage the adopt-now list. I then revise wave 2's design (packages, media engine, attachment model) before any imsg code changes.

## Wave 2: imsg build (after the gate)

The lettered items below (F, B, C, D, I, V) are wave 2. Their designs get revised by the research triage.

C grows to cover George's media-engine requirements:
- **Engines:** pluggable local and remote engines (Apple Speech/Vision via a Swift helper package `packages/apple/intel`, `hear`, whisper.cpp, OpenRouter models).
- **Preference order:** set in config, with a switchable default and a per-call `engine` override exposed in MCP params, a CLI flag and a TUI picker.
- **Routing:** cheap local signals pick the engine — audio length/loudness/SNR, local OCR confidence and text density, image size. Escalate to a stronger model only when needed, and record why.
- **Preprocessing:** audio normalisation and denoise (ffmpeg/afconvert), image resize/contrast, and **compression before any upload**.
- **Re-run:** `imsg reinterpret` (plus MCP and TUI) over a contact, thread, date range or kind with a new engine or settings. Cache provenance identifies stale rows.
- **Discoverability:** a TUI settings panel, CLI help and MCP descriptions all generated from one engine registry.

## Work breakdown

Each lettered item is one PR from one worktree (`~/repos/EQStack-wt/<slug>`). It owns the files listed, and its ledger row is claimed in HANDOFF §10a before starting.

**F — Foundation packages** (critical path; small)
- Add the workspace glob plus `@eqstack/apple-time`, `@eqstack/user-date` and `@eqstack/media-kind`, with exhaustive unit tests.
- Switch existing imsg call sites to them, with no behaviour change except the documented date grammar.
- Files: `pnpm-workspace.yaml`, `packages/time/**`, `packages/media/kind/**`, imsg imports.

**B — imsg data-access correctness** (after F)
- `search_attachments`:
  - compare `created_date` in **seconds** via apple-time;
  - an unparseable `since`/`until` becomes an error (matching `export_messages`);
  - one shared limit policy: explicit per-tool caps, `truncated:true` when a cap applies, descriptions generated from the policy, and the test at `list-completeness-metadata.test.ts:79` fixed;
  - plugin payloads excluded via media-kind, after a schema-only query on a real DB confirms their UTI;
  - `mimePrefix` matches inferred MIME, so `.caf` counts as `audio/x-caf`.
- `get_messages`: add `since`/`until`/`afterMessageId`, and an honest `hasMore`.
- Fixtures: seconds `created_date`, null-MIME `.caf` voice memos, plugin-payload rows, stickers, multi-attachment messages, text-heavy screenshots.
- Ledger rows closed: `attach-search-date-units`, `-iso-since`, `-limit-cap`, `-plugin-payloads`, `-caf-mime`.
- Files: `imessage-db.ts` attachment queries, `index.ts` `search_attachments`/`get_messages` handlers, `scripts/generate-fixtures.ts`, the limit helper in `mcp-tools.ts`.

**C — media-intel engine as a package** (after F; the longest item; runs parallel with B)
- C1: typed `InterpretResult` (`ok | refused | failed | unsupported`) with a validator: refusal patterns, empty or near-empty output, no-input sent. Only `ok` caches as `done`. Failures record every link's error.
- C2: capabilities per format plus a conversion stage. `afconvert` CAF/Opus→WAV or M4A (built into macOS); correct `image/png|jpeg`; a `models.audio` slot; the chain falls through **all** local transcribers, not just the first found.
- C3: local Apple engines. On-device **Speech** (SFSpeechRecognizer, on-device) for audio, and **Vision** OCR (VNRecognizeTextRequest) for images, run through a native helper (see the open question on how it's built).
- C4: image output splits into `ocrText` (verbatim, local), `caption` (1–2 sentences, LLM) and `bubbles[]` (`{side: owner|other, name?, text}`).
  - Prompt rule: right/coloured bubbles are the screenshot's owner; left/grey are the other party.
  - `max_tokens` ≥ 2k.
- C5: cache v2. New columns `pipeline_version`, `prompt_hash` and `model`; a migration; old rows auto-stale on a version bump. `force` evicts `done` rows. A one-time purge of refusal rows.
- Files: `packages/media/intel/**`; `apps/imsg-mcp/src/media-*.ts` become thin adapters; native helper.

**D — imsg surfacing** (after B and C; touches the schemas)
- Per-attachment `interpretation {caption, ocrText, transcript, source, status}` replaces message-level `interpretedMedia`.
- Inlined in `messageToStructured` once, so every message tool gets it: get, search, unread, export, events.
- Cached values only; it never triggers generation.
- `get_attachment {includeImage:false}`, and its advertised input gains `interpret`/`force`.
- Ledger row closed: `imsg-multi-attachment-captions`.

**K — mcp-kit v3** (parallel from day 1; another repo)
- zod 4 peer; `toMcpSchema` emitting 2020-12; registry with output schemas; conformance helper; publish 3.0.0.
- Telephony (and the other mcp-kit consumers: recall, up-bank, browser-tab) need a coordinated bump.

**T — telephony onto kit v3** (after K)
- zod 4 migration (`.strict`, `ZodTypeAny`, `ZodType<>`), delete `withoutSchemaDialect`, add the conformance test.
- Keep `tel mcp --surface member` and the `dist/cli.js` path unchanged: dotfiles' user-scope server depends on them.

**G — gmail onto kit v3** (after K)
- zod 4 (mostly `.passthrough` → `z.looseObject`).
- Collapse `toolDefinitions` and `OperationRegistry` into the kit registry, advertise output schemas, and use the kit dispatcher (keeping gmail's scope gate).

**I — imsg onto kit v3** (after K and D; last on the critical path)
- zod 4.
- Kit registry from `mcp-schemas.ts`, deleting the hand-written JSON input schemas (fixes `imsg-input-schema-drift`).
- Kit dispatcher plus sanitize/prompt-injection, deleting imsg's copies.
- Delete the #184 strip.

**V — acceptance and release** (after I)
- Conformance test in CI for all three apps: spawn each server, `tools/list`, Ajv2020 strict compile, and fixture tool calls whose `structuredContent` is validated against the advertised `outputSchema`. This is exactly the check the client failed.
- Live acceptance on the real thread from the Desktop agent's report (its four checks are kept machine-local, not in this public repo): every voice memo transcribed or an explicit error; a text-heavy screenshot's verbatim text present in `ocrText`; owner bubbles attributed to the owner; cached text inline in `get_messages` for every attachment.
- Re-interpret that thread's last-2-weeks media under the new engine.

## Critical path and parallelism

```
wave 1:  R1a ─┐
         R1b ─┼── GATE (George triages) ──┐
         R2  ─┤                           │
         R3  ─┘                           │
         L (local engines) ───────────────┤
         K ──┬── T                        │
             └── G                        │
wave 2:  F ──┬── B ──────────┐  ◄─────────┘
             └── C (C1..C5+) ┴── D ── I ── V      (I also needs K)
```
- Critical path: **R1 → gate → F → C → D → I → V**. Wave 1 runs about 5 agents at once (R1a, R1b, R2, R3, L), plus K in the owner's session, then T and G.
- Up to 4 writers at once (B, C, K, then T/G), each in its own worktree.
  - imsg-file hotspots are `index.ts` and `mcp-schemas.ts`. B and C are assigned disjoint regions. D and I are serial, so the schema files have one writer at a time.
- Merges are serial with one Release run each (imsg publishes). Order: F, B, C, D, then T and G whenever ready, then I, then V.
- Every agent gets an ownership map and its siblings' names (memory `feedback-parallel-agent-coordination`).
  - Bugs go to the HANDOFF §10a ledger.
  - Cross-repo talk (K) goes over the bus to `mcp-starter-template`.
- Blockers (an MCP or tool dying, a failed paid call, a needed credential) pause work and alert George with `wm ask` or a push notification, per the `asking-george` and `detecting-george-presence` skills.

## Parked and folded-in

- **GC-1 rehearsal** (`live-rehearsal-real-sessions`, `secretary-voice`, `gc1-step10-rerun`): stays parked as of the HANDOFF checkpoint. Before starting, I refresh the checkpoint with a line pointing here. T must keep the member surface working.
- **Folded in:** `schema-dialect-proper-fix` (K, T, G, I, V), `imsg-input-schema-drift` (I), `imsg-multi-attachment-captions` (D), the five attach-search rows (B).
- **Not folded:** `imsg-timing-flakes`, `member-identity-check`, `pr129-await-reply`.
- **Folded into wave 2:** tui-kit 0.6.0 bump plus ctrl-e/y in scrollable views, and `createVimKeyRouter()` for imsg's one-`useInput` router (DEFERRED #16a).
- **Backlog, recorded in HANDOFF §10 at wave 0, not built here:**
  - `humans-file-conventions`: checksum-based file and dir names, canonical cache dirs, a separate export dir per chat app, deterministic contact identity that survives a name change. George will brief this separately; wave 2's cache and export layout must not paint it into a corner.
  - `web-ui`: deferred until a **stateless Streamable-HTTP MCP endpoint** is solid. The web UI would be an export layer, essentially the TUI with a stylesheet.
  - `bun-runtime-eval`: measure moving the tools to bun, including the Rust-based fork R3 finds.

## Verification

- **Wave 1:**
  - Each Typst report compiles (`typst compile`) and cites `file:line` or URLs.
  - The NotebookLM notebooks exist, with sources listed (`notebook_list` and `source_list`).
  - Each local engine transcribes or OCRs a synthetic sample.
  - Kit v3 passes its own conformance helper against T's and G's tool lists.
- Every PR: per-app `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` as separate commands; `pnpm test:rust` if native changes; root `pnpm verify`; mutation-check each new guard.
- New fixture-backed tests for each bug. The conformance suite is the regression gate for the schema class.
- After imsg releases: `imsg --version`; rebuild the dist that Claude Desktop runs; restart Desktop; run the four acceptance checks through the MCP tools.
