# PHASE Q — `delegate` mode: a briefed ElevenLabs agent holds the call

> Read [`WORKSTREAM.md`](./WORKSTREAM.md) then [`DECISIONS.md`](./DECISIONS.md) first.
> Where this file and WORKSTREAM.md disagree, WORKSTREAM.md is right.
>
> **Paths** are relative to `apps/telephony-mcp/`. Line numbers are against the tree
> as read on 2026-09-09.

**One sentence:** ElevenLabs holds the number, the agent and the whole media path,
so a `delegate` call costs the callee no dead air — and our only job is to brief the
agent, start the call, and feed transcript plus a terminal flag back to the
originating agent through the *existing* long-poll, adding no new tool and no new
public route.

---

## Why this phase exists now, and what changed under it

Phase E measured a direct-mode turn at **~12 s**, essentially all response
generation, with the network at ~0–1 ms (D-64). Phase F would mask that; `delegate`
removes it, because ElevenLabs runs STT → LLM → TTS at its own edge. George chose
Q/R over F on that evidence (**D-65**). F is not rejected — it still applies to
`direct`, which survives as a mode — it is simply behind this.

Four things the original sketch in `LATER-phases.md` did not know, all settled since:

| Was | Now |
|---|---|
| "**O-1 blocks this outright** — one number, one handler" | **RESOLVED (D-69).** A second number was bought for ElevenLabs: `+61 3 4713 9984`, Melbourne local, voice-only, $3.00 USD/month. The gateway keeps `+61…1463` permanently. |
| Number not registered | **DONE (D-73).** Registered as `phnum_7001m1qjaq8dfpttztdw4t1dt919`, label `eqstack-telephony-agent`, inbound + outbound. |
| Master Twilio credentials would go to a third party | **Isolated (D-73).** The number lives in its own Twilio subaccount, so what EL holds reaches exactly one subaccount containing exactly one number. |
| Tunnel unprovisioned | **Live (D-67/D-74).** `gw.agentpipe.top` is up under launchd. **Phase Q does not need it** — see Non-goals. |

**Empirically confirmed, not assumed (D-73):** on registration EL rewrote the
subaccount number's `voice_url` to `https://api.elevenlabs.io/twilio/inbound_call`.
It *does* seize the inbound handler — which is exactly why it has its own number,
and why `+61…1463` still carries Twilio's demo URL, untouched.

---

## Inherited invariants

| INV | How it binds this phase |
|---|---|
| **INV-1** | No new tool is added, so no new name to get wrong. If a step here proposes `delegate_call`, that step is wrong — see Scope §1. |
| **INV-5** | One definition per operation. `delegate` is a **mode value on the existing `place_call`**, not a second command. Anything the mode needs goes in the existing spec's input, Zod-parsed. |
| **INV-6** | Parse, don't guess. Every ElevenLabs API response is Zod-parsed at the adapter boundary before it becomes a domain type. EL is a third party whose payloads we do not control; `String(x ?? "")` on that boundary is the exact pattern Phase B deleted. |
| **INV-7** | **The load-bearing one.** `laptop (commands) → ElevenLabs → Twilio → callee`. Our gateway is out of the media path entirely: no `RelaySession`, no ConversationRelay WS, no `/relay/<token>` for a delegate call. Draw the hop diagram before writing code and delete every hop that exists only because the laptop was in the way. |
| **INV-8** | Surface parity is structural. Because `delegate` is a mode rather than a tool, CLI/MCP/REST/console get it for free the moment the spec's enum accepts it. If any adapter needs a bespoke branch, the seam is wrong. |
| **INV-9** | Single WAL writer. Only `serve` writes the synthesized events and the agent-mapping table. CLI/MCP readers stay read-only. |
| **INV-10** | **Phase Q adds NO public route.** Transcript comes back by polling EL, not by an inbound webhook — argued in Scope §3. The `mcp.` hostname reserved by D-36 is Phase R's, not Q's. |
| **INV-11** | Full E.164 exists only in config and in the request to EL. Everything persisted, logged or emitted carries alias + last four. The callee's number must not appear in an EL agent name, a dynamic variable we log, or an event payload. |
| **INV-12** | `ELEVENLABS_API_KEY` resolves by NAME via env → opkeep. Never a literal in config, code, tests or fixtures, and never logged. |
| **INV-14** | Steps 1–7 are verified offline against a fake agent-platform port; the default suite makes no network calls. Step 8 is a real paid call **and bills EL agent minutes on top of Twilio** — it needs George's authorisation at the time. |
| **INV-15** | `private: true` stays. Nothing here flips it. |
| **INV-16** | One merge, wait for the Release run, then the next. |

---

## Scope

### 1. `delegate` becomes a real mode, by flipping one row

`CALL_MODE_SPECS.delegate.implemented` is `false` (`src/domain/types.ts:109-115`),
and `src/domain/call-requests.ts:57` refuses construction on it. Phase Q flips that
single boolean. Its other flags are already correct and describe the mode exactly:
`gatewayDrivesTurns: false`, `hostAnswersTurns: false`, `mediaPathOffDevice: true`,
`supportsConsult: false` (consult is Phase R).

**Everything downstream must branch on those predicates, never on the string
`"delegate"`** — that is D-34's rule and the reason the spec table exists.

Two behaviours fall directly out of the predicates and must be pinned by tests:

- `say_on_call` is **refused** in delegate mode, because `hostAnswersTurns` is false.
  The host does not speak; the EL agent does. The refusal must name the mode and
  suggest `get_call_events`, not fail obscurely.
- The session code that builds a relay token and WS URL must not run at all, because
  `mediaPathOffDevice` is true. If a delegate call ever produces a `/relay/<token>`,
  INV-7 has been violated.

### 2. A new port, and a deliberate redesign of a reserved id

`TelephonyAdapter.createCall(spec: OutboundCallSpec)` (`src/domain/ports.ts:31-53`)
takes `relayWsUrl`, `statusCallbackUrl`, `recordingStatusCallbackUrl` — a delegate
call has none of those. Widening `OutboundCallSpec` with four optional fields would
make every field optional-in-principle and defeat INV-6.

So Phase Q adds a **second port**, `AgentPlatformPort`, beside the telephony one:

```ts
ensureAgent(brief: AgentBrief): Promise<{ agentId: string }>
placeOutboundCall(req: { agentId; phoneNumberId; to; dynamicVariables }): Promise<{ conversationId: string }>
getConversation(conversationId: string): Promise<AgentConversation>   // status + transcript
endConversation(conversationId: string): Promise<void>
```

⚠️ **This is a deliberate redesign and owes a `DECISIONS.md` row before it lands.**
`elevenlabs-managed` was reserved as a *telephony adapter id*
(`src/adapters/telephony/registry.ts:10`, `src/config/schema.ts:91`), i.e. as
another `TelephonyAdapter`. Implementing it as a separate port instead is a change
to that reservation, not an implementation of it. The workstream permits redesign
and requires it be recorded with a reason — this file is not that record.

Keep the reserved id refusing construction with an error that now **points at the
new config key** rather than saying "future version": a stale refusal message is
worse than none.

### 3. Transcript comes back by POLLING, not by a webhook — and why

The originating agent's loop must not change: `place_call` → `get_call_events` with
`waitMs` → read `turn.user` / `turn.agent` → terminal flag. That loop is the whole
UX and it already works.

Two ways to feed it:

| | How | Cost |
|---|---|---|
| **(a) Poll EL from `serve`** ✅ | A per-call poller calls `getConversation`, diffs against what is already stored, and writes the *same* `turn.user` / `turn.agent` / `call.ended` events into the existing `EventStore` | One background poller; transcript lags EL by the poll interval |
| (b) EL post-call webhook | EL posts to a new public route on our gateway | A **new public surface** with a third party's own signature scheme — a new trust model, which INV-10 says must be argued individually, and which Phase R needs anyway for the tool channel |

**Take (a).** It adds no public route, reuses the event feed unchanged, and means
`get_call_events`, `get_transcript`, `search_calls` and the console live view all
work for delegate calls with **zero** changes. (b) is Phase R's problem, where an
authenticated inbound surface is unavoidable because the consult loop *is* inbound.

The poll interval is a real trade: too fast burns EL API calls, too slow makes the
console feel dead. Start at 2 s while a call is live, stop on terminal status.

### 4. The brief: reuse `profiles`, do not invent a second config concept

`profiles.<name>` already carries `systemPrompt`, `greeting`, `maxDurationMinutes`
and `record` — which map 1:1 onto EL's agent prompt, `first_message`, duration cap
and recording. A delegate call briefs an agent from the same profile a direct call
uses. No new config shape.

**Agent lifecycle: one agent per profile, not one per call.** Creating an agent per
call litters the workspace and is slower. Derive a deterministic name
(`eqstack-<profile>`), create on first use, store `profile → agentId` plus a hash of
the brief in sqlite, and re-`update` the agent when the hash changes. That makes
provisioning idempotent — the same property `place_call` already has for dialing.

### 5. O-24 lands here, because the agent prompt *is* the harness

This is the first phase with a driving model whose prompt we own, so the parked
conversation-harness preamble (**O-24**) stops being theoretical. Compose the EL
agent prompt as `harness preamble + profile.systemPrompt`, where the preamble:

- warns that transcripts are approximate and STT mangles proper nouns phonetically
  (George's own call produced "cloudflare" → "cloud flood", "claude code" →
  "cord code");
- licenses charitable, context-driven correction of obvious mis-hearings;
- **requires** that for an important word — a name, number, command or confirmation
  — the agent does **not** guess, but says the line broke up and asks the human to
  repeat or spell it.

Pin the composition with a unit test, so a future profile edit cannot silently drop
the preamble. **O-25** (structured-output turns) is *not* in scope: EL owns the turn
loop in this mode, so the JSON-schema turn contract belongs to `byo-model` (Phase T).
**O-26** (never hang up before playback finishes) is EL's responsibility here, not
ours — verify it on the live call rather than building for it.

---

## Non-goals

- **The consult loop.** Registering our MCP as a tool source on the agent, the
  callback queue, `pre_tool_speech` — all Phase R. `supportsConsult` stays `false`.
- **The tunnel.** Q needs no public reachability at all; a delegate call is
  laptop-out-of-path in both directions. The tunnel is already live and Phase R will
  use it via the `mcp.` hostname (D-36).
- **Inbound.** The EL number takes inbound calls to the agent by construction, but
  routing an inbound call *back to an originating agent* is Phases L–M.
- **Phase F's thinking sound.** EL ships `pre_tool_speech` and `tool_call_sound`
  natively; building ours for this path would be duplicated work (D-65).
- **Recording.** Delegate-mode recording lives in EL, not in our
  `EncryptedRecordingStore`. Do not silently persist EL recordings — INV-13's
  guarantees do not extend to a third party's storage, and claiming they do would be
  a lie in the consent surface. Out of scope; note it in the mode's docs.

---

## Steps

### 1. Port + types (`src/domain/ports.ts`, `src/domain/types.ts`)
Add `AgentPlatformPort`, `AgentBrief`, `AgentConversation`. Flip
`CALL_MODE_SPECS.delegate.implemented` to `true`.

### 2. Adapter (`src/adapters/agent-platform/elevenlabs.ts`, `.../registry.ts`)
Implement the port against EL's REST API. **Zod-parse every response** (INV-6).
Resolve `ELEVENLABS_API_KEY` through `SecretProvider` by name (INV-12). Update the
telephony registry's reserved-id error to point at the new config key.

### 3. Config (`src/config/schema.ts`)
An `agentPlatform` block: `{ type: "elevenlabs", apiKeyRef, phoneNumberId }`.
`phoneNumberId` is EL's `phnum_…`, not a phone number — it is not INV-11-sensitive,
but the number it maps to is, so never log the pair together.

### 4. Agent provisioning (`src/domain/agent-brief.ts`, store table)
Pure `buildBrief(profile, harnessPreamble) → AgentBrief` + a `briefHash`. New
`agent_profiles` table mapping `profile → { agentId, briefHash }`. Pure function,
testable with no network.

### 5. Call path (`src/gateway/call-service.ts`)
Branch on `CALL_MODE_SPECS[mode].mediaPathOffDevice` — never on the string. Delegate
path: `ensureAgent` → `placeOutboundCall` → persist the call with the EL
`conversationId` as `providerCallId` → start the poller. Idempotency, dryRun and the
concurrency check apply unchanged; dryRun must show the resolved agent and brief
without creating anything on EL.

### 6. Poller (`src/gateway/delegate-poller.ts`)
Per-call, 2 s while live, stops on terminal status. Diffs `getConversation` against
stored events and appends only new ones. Writes `call.ended` with the terminal
reason. Must be idempotent — a duplicated poll must not double-write a turn.

### 7. Refusals + tests (`tests/`)
Pin: `say_on_call` refused in delegate mode with a mode-naming error; no relay token
or WS URL is ever built for a delegate call; the harness preamble is present in the
composed brief; the poller is idempotent; `place_call --mode delegate --dry-run`
creates nothing. All against a fake `AgentPlatformPort` — **no network** (INV-14).

### 8. The live call (paid, George-authorised — NOT part of the merge)
One real delegate call to George. Measure the same legs Phase E measured, so D-65's
thesis is tested rather than asserted: if a delegate turn is not dramatically under
direct's ~12 s p50, the premise for choosing Q/R over F was wrong and that belongs
in `DECISIONS.md` as a correction.

---

## Verification

- `pnpm --filter telephony-mcp lint typecheck test` — the narrow gate.
- Root `pnpm verify`.
- Golden pins: the tool **count is unchanged** (13). If a pin count moves, a tool was
  added and Scope §1 was violated.
- `place_call --mode delegate --dry-run` prints the resolved agent + brief and
  touches nothing on EL.
- Live: one paid call, then compare `direct.turn` p50 against the delegate turn.

---

## Seam left behind

| For | What Q leaves |
|---|---|
| **R (consult)** | The `AgentPlatformPort` and the EL adapter. R adds `registerMcpServer` to the same port and flips `supportsConsult`. R must **not** introduce a second EL client. |
| **T (byo-model)** | The harness-preamble composition (O-24) is mode-agnostic and is where O-25's structured-output turns attach. |
| **I / G (views)** | Nothing to do. Delegate calls emit the same event types into the same store, so the console and future TUI render them unchanged. That is the test of whether §3's polling decision was right. |
| **L–M (inbound)** | The EL number already answers inbound to the agent. What is missing is routing an inbound call back to an originating agent — untouched here. |

---

## Open questions

1. **`agent-platform-port-redesign`** — implementing `elevenlabs-managed` as a
   separate port rather than a `TelephonyAdapter` reverses a reservation. Owes a
   `DECISIONS.md` row with its reason before the code lands. *Owner: implementer.*
2. **`delegate-cost-ceiling`** (was O-5) — EL agent minutes bill on top of Twilio.
   `maxDurationMinutes` caps one call; nothing caps a day. Needed before any
   unattended or inbound use, not before the first attended call. *Owner: George.*
3. **`delegate-recording-consent`** — recording in this mode happens inside EL, so
   INV-13's at-rest guarantees do not apply. Either refuse `record: true` for
   delegate calls or state plainly in the consent surface that the recording lives at
   a third party. Refusing is the honest default. *Owner: George.*
4. **`poll-interval`** — 2 s is a guess. The live call in Step 8 is the chance to
   measure how stale the console actually feels and adjust once, with data.
