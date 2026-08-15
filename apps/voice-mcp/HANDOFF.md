# voice-mcp — handoff & migration notes

> **Traveling doc.** This file lives inside `apps/voice-mcp/` so it moves with
> the tool when it migrates out of `life-stack`. It is the single place a new
> agent should start. It consolidates the tool-specific notes that were
> otherwise scattered across `life-stack` repo-level files (see
> [Migration manifest](#migration-manifest)).
>
> Author of record: George (`george.g93@gmail.com`). Last updated 2026-08-02.
> Fuller design history: [`README.md`](./README.md),
> [`AGENTS.md`](./AGENTS.md), and the life-stack ExecPlan
> `docs/exec-plans/active/2026-08-02-voice-mcp.md` (moves with this dir).

## Migration status (updated 2026-08-05)

**Migrated into EQStack.** The tool now lives at `EQStack/apps/voice-mcp/`
(copied from `life-stack`, build artifacts excluded) and was rewired to EQStack
conventions: package renamed `@george43g/voice-mcp` → `voice-mcp`; deps on
`@eqstack/{tsconfig,vitest-config,biome-config}`; `vitest.config.ts` uses the
`sharedTest` preset; local `biome.json` added. **Verified green from the new
location:** typecheck clean, 98/98 tests (no network), lint clean, and `doctor`
resolves config + state (both live under `~/`, so they're path-independent).
The life-stack original and its repo-level wiring were torn down the same day.

**Left for the EQStack agent (this repo owns these):**
- **Commit the migration.** Uncommitted here: `apps/voice-mcp/`, the `README.md`
  apps-table row, and `pnpm-lock.yaml`. Branch off `main` (EQStack uses PRs).
- **MCP wiring** is in place locally but **gitignored** in EQStack (`.mcp.json` /
  `opencode.json` hold absolute paths): a direct `voice-mcp` entry was added and
  `.cursor`/`.warp` reflect it. Confirm it launches in your host.
- **Doc drift:** EQStack root `AGENTS.md` still points MCP-config regen at the
  retired `~/dotfiles/mcp/render.js`. The replacement is the global **`mcpsync`**
  tool: `mcpsync -c ./.mcp.json apply --scope project --to opencode`. Update it to
  match (life-stack's `AGENTS.md` was already updated).

The [Migration manifest](#migration-manifest) below is now a historical record of
what moved (kept for provenance).

## Status at a glance

- **Built and green.** Full domain/gateway/MCP/CLI implementation. 98 tests
  passing across 11 files; `mise run voice-mcp:check` (lint + typecheck +
  tests) clean; no network, no paid calls in the default suite.
- **Proven live, twice, on 2026-08-02:**
  1. *LLM-mode smoke call* — real call to George (65 s, 5 turns, 2 clean
     barge-ins). Warm-turn latency p50 ≈ 714 ms (end-of-turn → first token to
     Twilio), target ≤ 1.0 s met; cold first turn 1429 ms.
  2. *Direct-mode ("walkie-talkie") call* — Claude, as the MCP host, held a
     ~3.5 min spoken conversation with George with **no intermediary LLM
     agent**: 7 user turns, 5 verbatim `voice_say` replies, 2 clean barge-ins,
     recording toggled on mid-call by voice, spoken summary on request.
- **Uncommitted by instruction.** Every byte of this tool is uncommitted in
  the life-stack working tree. George asked to hold all commits pending the
  relocation decision. Do not commit into life-stack.
- **Relocation is the reason this doc exists.** voice-mcp is expected to move
  into a future personal-comms monorepo (working names **EQ-Stack /
  Human-tools / humanstack**) alongside a messages MCP, a gmail MCP, and
  relationship-analytics tooling — sharing contact-context packages (message /
  email history, per-contact relationship summaries), robustness libraries,
  shared TUI libraries, and the MCP dev-server setup.

## Two conversation modes

The call driver is chosen at `voice_prepare_call` time via `mode`:

- **`llm` (default).** The configured OpenRouter model conducts the call from
  the objective + system prompt. Fast (sub-second warm turns). This is the
  "AI assistant makes a call on George's behalf" path.
- **`direct` ("walkie-talkie mode").** The gateway runs **no** LLM turn loop.
  It records the callee's utterance, inlines the text on the `turn.user`
  event, and waits. The **MCP host is the brain**: it long-polls
  `voice_get_events { waitMs: 25000 }` for the next `turn.user`, then replies
  verbatim with `voice_say`. This lets a human talk *directly to the agent* on
  the other end of a phone line. Per-reply latency is a few seconds (one MCP
  round-trip + one model turn) — accepted as the cost of "it's really you."

Direct-mode safety note: in direct mode there is **no system-prompted LLM
mediating** what gets spoken. Whatever the host passes to `voice_say` is
spoken verbatim to a real person. The two-stage dial gate, allowlist,
last-four redaction, and consent/recording invariants all still apply
unchanged.

## Ideas from the 2026-08-02 phone call

George raised two ideas live on the direct-mode call. Both are recorded here
so whoever picks up development sees the intent:

1. **Name: "walkie-talkie mode"** for direct mode — it captures the
   turn-taking, push-to-talk feel of the round-trip cadence. Adopt this
   vocabulary in docs/UX.
2. **Thinking-sound loop** — instead of dead air during the reply round-trip,
   play a soft looping tone / ambient bed so the line audibly stays connected,
   and cut it the instant Claude's reply begins. **This is the next feature to
   build — full spec below.**

## NEXT FEATURE — walkie-talkie thinking-sound loop

**Goal.** In direct mode, fill the multi-second silence between the caller
finishing a sentence and Claude's spoken reply with a quiet, looping
"thinking" sound, so the line never feels dropped. The sound must stop the
moment the reply's TTS begins, and on barge-in, call end, or timeout.

**Mechanism is confirmed against Twilio's ConversationRelay contract.**
ConversationRelay accepts an app→relay `play` message
(https://www.twilio.com/docs/voice/conversationrelay/websocket-messages):

```json
{ "type": "play", "source": "https://.../thinking.mp3",
  "loop": 0, "preemptible": true, "interruptible": true }
```

- `loop: 0` plays up to 1000 times — effectively "loop until replaced."
- `preemptible: true` means the next app message **replaces** the current one —
  so the existing `text` reply frame auto-preempts the loop with no explicit
  stop needed.
- `interruptible: true` means caller speech (barge-in) stops it.

**Exact integration sites (already located):**

- `src/adapters/telephony/relay-messages.ts` — add a `playFrame(source, {
  loop, preemptible, interruptible })` builder beside the existing
  `textFrame` / `endFrame`. (This file only defines outbound builders
  `textFrame`/`endFrame` today.)
- `src/gateway/session.ts`, `handleTurn`, the `if (this.mode === "direct")
  return;` at ~line 137 — **before returning**, send the `play` loop frame
  (`loop:0, preemptible:true, interruptible:true`) and set a `thinkingActive`
  flag.
- `src/gateway/session.ts`, `sendText` at ~line 241 — the reply
  `textFrame(text, true)` already preempts the loop because it was
  `preemptible`. Clear `thinkingActive`. (Optionally send an explicit stop
  first if testing shows a gap.)
- `handleInterrupt` (~line 204) and `end`/close paths — clear `thinkingActive`;
  `interruptible:true` already stops the audio on barge-in.

**Config.** Add an optional `voice.thinkingSound` block, e.g.
`{ enabled?: boolean, url?: string, maxLoopSec?: number }`. Gate to direct
mode only (llm mode already replies sub-second). Ship a default subtle,
seamless-loop, low-volume asset.

**Serving the audio.** Twilio fetches `source` over the public internet, so
the file must be reachable at a public URL. Options: (a) a new **static**
`GET /thinking-sound.<ext>` route on the existing public listener under
`server.publicBaseUrl` — note this is unauthenticated (Twilio's media fetch
can't carry an X-Twilio-Signature), so keep it a static, cacheable,
non-sensitive file and **do not** put it under `/relay`; or (b) host on Twilio
Assets / any public URL. Preserve the "public surface stays minimal" rule in
`AGENTS.md`.

**Tests to add** (fake-WS harness in `tests/gateway.integration.test.ts`):
- After a direct-mode `turn.user`, assert a `play` frame with `loop:0`,
  `preemptible:true`, `interruptible:true` is sent to the WS.
- After `voice_say`/`sendText`, assert the `text` reply frame follows (relying
  on preemption) — and if an explicit stop is implemented, assert it precedes
  the reply.
- Assert **no** `play` frames are emitted in `llm` mode.
- Assert the loop stops on barge-in, on `end`, and after `maxLoopSec`.

**Open questions for the implementer:**
- Verify empirically that a `preemptible` `play` is cleanly replaced by the
  next `text` frame with no audible overlap or clipping of the first TTS word.
- Pick/produce the default asset (seamless short loop, royalty-free or
  synthesized; keep it quiet and non-annoying over a phone codec).
- Decide behavior at `maxLoopSec` (silence vs. a gentle "still here").
- Confirm start latency of `play` is well under the dead-air it masks.

## Planned feature — inbound / return calls

**Goal.** Let an allowlisted person **call the number and reach the agent**,
instead of only receiving agent-initiated calls. Naturally pairs with direct
mode: the caller talks to the same host-as-brain, greeted by name.

**Current state (verified 2026-08-02).** There is no inbound path today, on
either side:

- The gateway is **outbound-only**. The public listener
  (`src/gateway/public-server.ts`) accepts exactly `POST /twilio/status`,
  `POST /twilio/recording`, and the `/relay/<token>` WS upgrade — anything else
  is rejected. Nothing returns TwiML for "a call comes in."
- The Twilio number `+61447771463` still carries Twilio's **factory-default**
  inbound webhooks: `voice_url = https://demo.twilio.com/welcome/voice/`,
  `sms_url = https://demo.twilio.com/welcome/sms/reply`, no
  `voice_application_sid`. So a callback today hits Twilio's generic demo
  greeting and **never reaches the gateway or George's machine**; a text hits
  the demo SMS auto-reply.

**Shape to build.**

- Add a signature-validated inbound voice route (e.g. `POST /twilio/voice`) on
  the public listener that returns `<Connect><ConversationRelay …>` TwiML — the
  same relay config the outbound path already builds — and attaches the WS
  session to the existing `RelaySession` brain (direct or an `llm` profile).
- Point the number's Voice "A call comes in" webhook at
  `${server.publicBaseUrl}/twilio/voice`. This is a **live Twilio-side change**
  to the IncomingPhoneNumber (`VoiceUrl`), not part of our config file, and is
  separate authority from placing calls.
- Gate inbound by caller: resolve the `From` number against the recipient
  allowlist; only known callers are connected (greeted by name), others get a
  polite decline. Keep the "public surface stays minimal" and
  signature-validation rules in `AGENTS.md`.

**Open questions for the implementer.**

- Inbound has no `voice_prepare_call` / two-stage gate — decide how a
  `CallRequest`/`CallRecord` (and consent/recording policy) is created for a
  call the agent didn't initiate.
- In direct mode the host must be *told* a call came in: add an "incoming
  call" signal the MCP host can long-poll (a global event / notification) so it
  can pick up and start replying via `voice_say`.
- Default inbound driver: `llm` (auto-answer from a profile) vs `direct`
  (waits for the host) — likely per-recipient or per-number config.

## Open observation — dead-air is confusing (to workshop)

Live direct-mode calls on 2026-08-02 surfaced a real UX problem worth flagging
for whoever resumes this: the multi-second gap between the callee finishing a
sentence and the reply starting reads as a **dropped line, not as "thinking."**
Concretely, the auto-greeting was talked over within a word or two on more than
one call, and a callee asked *"hello — are you there?"* mid-exchange, unsure
anyone was still connected. This is recorded as a known problem only — **no
solution is proposed here; we'll workshop the approach when we pick this back
up.**

## Migration manifest

When the tool moves to the new repo, this is the complete, verified footprint.
The working-tree rule of thumb George gave holds: **the relevant files are the
uncommitted ones that are part of the new tool** — but not *all* uncommitted
files are voice-mcp (see "Leave behind"). Nothing here is committed yet.

### Moves wholesale (self-contained)

| Path | Notes |
| --- | --- |
| `apps/voice-mcp/` | The entire tool, incl. this file, `README.md`, `AGENTS.md`, `config.example.json`, `src/`, `tests/`, `package.json`, `tsconfig*.json`, `vitest.config.ts`. Untracked. |
| `docs/exec-plans/active/2026-08-02-voice-mcp.md` | The ExecPlan / build record. Untracked. Move into the new repo's plans dir (or `apps/voice-mcp/docs/`). |

### Internal dependencies it needs (bring these too)

`package.json` declares two `workspace:*` devDeps — the only internal
dependencies (verified: no other `@george43g/*` imports in `src`/`tests`):

- `@george43g/tsconfig` → `packages/tsconfig` (`tsconfig.json` extends
  `@george43g/tsconfig/node`).
- `@george43g/vitest-config` → `packages/vitest-config` (`vitest.config.ts`
  uses its app preset).

In the new repo either vendor these two packages, publish/consume them, or
inline the two configs (a `tsconfig` base + a vitest preset). Runtime deps are
all external: `@modelcontextprotocol/sdk ^1.29`, `commander ^14`, `ws ^8.18`,
`zod ^3.25`; devDeps add `tsx`, `typescript ^5.7`, `vitest ^3.2`,
`@types/node ^24`, `@types/ws`. Requires **Node ≥ 24** (uses `node:sqlite`
with FTS5). The pnpm workspace picks the app up automatically via the
`apps/*` glob in `pnpm-workspace.yaml`.

### Repo-level edits to REVERT in life-stack at migration (captured verbatim)

These are the tool-specific "notes" woven into shared life-stack files. They
are **left in place and functional for now** (the tool still runs here and
George may keep using it before the cut). At migration, revert each and
recreate the equivalent in the new repo. Hand-edited files:

- **`.mcp.json`** — remove the `voice-mcp` server block:
  ```json
  "voice-mcp": {
    "command": "node",
    "args": ["node_modules/tsx/dist/cli.mjs", "apps/voice-mcp/src/cli.ts", "mcp"]
  }
  ```
  (The `.bin/tsx` shim is a shell script `node` can't exec — hence the direct
  `tsx/dist/cli.mjs` path. Reproduce the same shape in the new repo, adjusting
  the `apps/voice-mcp/src/cli.ts` path.)
- **`ARCHITECTURE.md`** — remove two rows: the `Voice calls | apps/voice-mcp/`
  domain row, and the `Voice-call MCP/gateway | mise run voice-mcp:check`
  verification-surface row.
- **`docs/exec-plans/active/README.md`** — remove the
  `2026-08-02-voice-mcp.md` list item.
- **`mise.toml`** — remove the four `[tasks."voice-mcp:*"]` blocks (`mcp`,
  `serve`, `doctor`, `check`).

Generated / lock files (do **not** hand-edit — regenerate):

- **`opencode.json`** — regenerate after reverting `.mcp.json`:
  `node ~/dotfiles/mcp/render.js --manifest .mcp.json --opencode opencode.json`.
- **`pnpm-lock.yaml`** — regenerate with `pnpm install` after the
  `apps/voice-mcp/` directory is gone.

### External — not in git, must be recreated/copied by hand

- **`~/.config/voice-mcp/config.json`** — the live config (real E.164 numbers,
  real voice id, tunnel URL, model). Never committed. Copy/recreate in the new
  environment from `config.example.json`. Recipients currently configured:
  `george` (real number, `preconsented`) and `selftest` (the account's own
  Twilio number, `never` — a zero-risk diagnostic dial target).
- **`~/Library/Application Support/voice-mcp/`** — sqlite WAL state
  (calls/events/transcripts/FTS) + AES-256-GCM recordings. Local only. Includes
  the 2026-08-02 call history + one 84 s encrypted recording
  (`REf1b9e505eb135631f17fb3445cf95f50`). Decide whether history migrates.
- **Secrets** (resolve by name via env → opkeep keychain, never in git):
  `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`,
  `TWILIO_AUTH_TOKEN`, `OPENROUTER_API_KEY`. See "Operational gotchas" for the
  Twilio account subtlety.
- **cloudflared** (Quick Tunnel client) — installed via Homebrew during the
  smoke test; the new environment needs a public HTTPS tunnel to reach `serve`.

### Leave behind in life-stack (uncommitted, but NOT voice-mcp)

These uncommitted changes belong to life-stack and must **not** migrate:

- `apps/android/os-fork/ci/hetzner/dashboard/public/index.html`,
  `apps/android/os-fork/ci/hetzner/dashboard/server.js`,
  `apps/signal/src/chatbot.ts` — pre-existing repo-lint fixes made so
  `mise run verify` passed during the voice-mcp build (other workstreams'
  code; behavior unchanged).
- `apps/android/os-fork/signing/tools/` — unrelated os-fork work.

### New-repo bring-up checklist

1. Copy `apps/voice-mcp/` + the two internal packages (or inline their config).
2. `pnpm install`; confirm Node ≥ 24.
3. `mise run voice-mcp:check` (or `pnpm --filter @george43g/voice-mcp test`
   `typecheck` `lint`) → expect 98 green, no network.
4. Recreate `~/.config/voice-mcp/config.json`; ensure the five secrets resolve
   (`voice-mcp doctor` all-green).
5. Recreate the `.mcp.json` entry and any task-runner equivalents of the mise
   tasks.
6. Start a tunnel, set `server.publicBaseUrl`, `voice-mcp serve`, and validate
   with a `selftest` dial before any human call.

## Operational gotchas (learned live)

- **Twilio account.** The working live account is op item `twilio-us1-live`
  ("MWC Billing & AI"), one voice-capable AU number (…1463). The
  keychain-cached `twilio-au1-live` credentials are **stale — 401** on both
  `api.twilio.com` and `api.au1.twilio.com`. No dedicated API Key (`SK…`) pair
  exists; the smoke test aliased account SID + auth token as
  `TWILIO_API_KEY`/`TWILIO_API_SECRET` (Twilio REST accepts that basic-auth
  pair). RESOLVED 2026-08-16 (life-stack session): dotfiles templates now
  point `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` at `twilio-us1-live`; the
  stale `twilio-au1-{live,test}` items are archived (recoverable), not
  deleted. Minting a real US1 `SK…` key remains the proper fix.
- **Voice-string decimals.** Twilio error `64101` (`Invalid values
  (block_elevenlabs/…) for tts settings`) is a **format** bug, not an account
  block: a settings value rendered as a bare integer (`…-1_0.7_0.8`).
  `buildVoiceString` now forces a decimal point (`1.0_0.7_0.8`). ConversationRelay +
  ElevenLabs (voice Charlie `IKne3meq5aSn9XLyUdCD`, en-AU) + Deepgram Flux STT
  all work on this account with no extra console enablement.
- **Quick Tunnel URLs are per-process.** Restarting cloudflared mints a new
  `*.trycloudflare.com` host; update `server.publicBaseUrl` and restart
  `serve` together.
- **Diagnostic dial.** Calling the account's own Twilio number (`selftest`,
  policy `never`) answers with Twilio's demo message — a ~zero-risk way to
  validate TwiML/TTS/session setup on a real answered call without ringing a
  human. Caveat: the demo line hangs up too fast to finalize a `prompt`, so it
  can't exercise a full direct-mode utterance round-trip — that needs a real
  human callee.

## Deferred / follow-up work

- **Build the thinking-sound loop** (spec above) — top of the list.
- **Inbound / return calls** (section above) — let allowlisted callers reach
  the agent; the number currently answers callbacks with Twilio's demo, not us.
- **Dead-air UX** (observation above) — the lag silence reads as a dropped
  call; solution deliberately left open, to workshop on resume.
- Formal ≥ 20-turn latency acceptance run (p50 ≤ 1.0 s / p95 ≤ 1.5 s
  end-of-turn → first audio; barge-in stop ≤ 500 ms). Only a single smoke call
  measured so far.
- Mint a dedicated Twilio API Key (`SK…`) instead of aliasing account SID +
  auth token; repoint/refresh the stale AU1 keychain cache.
- Reserved adapter ids `elevenlabs-managed` and `twilio-media-streams` parse
  but refuse construction — implement only with latency evidence justifying the
  switch away from ConversationRelay.
- Public Streamable-HTTP MCP with OAuth is explicitly deferred (local stdio +
  cursor polling for now).
