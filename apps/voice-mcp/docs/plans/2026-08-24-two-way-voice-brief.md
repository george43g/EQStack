# Brief — live two-way agent calls (planning input, 2026-08-24)

**Status:** input for a planning session. Nothing here is a decision; §7 lists what
the session has to decide. Written against the tree at `4e2d595`.

---

## 0. The headline: most of what you asked for is already built and was proven live

The single most important thing to know before planning:

> **"An agent calls me and we talk back and forth directly"** is not a feature to
> build. It exists, it is called **direct mode / walkie-talkie mode**, and it was
> proven on a real call on **2026-08-02**: a ~3.5-minute spoken conversation, 7
> user turns, 5 verbatim replies, 2 clean barge-ins, recording toggled mid-call by
> voice — with **no intermediary LLM agent**. Claude was the brain, on the phone,
> live.

Both modes you described already exist and are chosen per call at prepare time
(`mode` on `voice_prepare_call`):

| Mode | Who is the brain | What it is |
|---|---|---|
| `llm` (default) | The configured OpenRouter model | Your "brief a voice agent, get a summary" option |
| `direct` | **The MCP host — the agent you're talking to** | Your "talk to me directly" option |

The mechanism (`src/gateway/session.ts:136-137`) is one line: in direct mode the
gateway records the utterance, emits `turn.user` with the text inlined, and
**returns without running any LLM loop**. The host long-polls `voice_get_events
{ waitMs }` (≤55 s) and answers with `voice_say`, which is spoken verbatim.

**So this planning session is not "build two-way voice." It is "productionise a
proven prototype."** That reframe should shape the whole plan — the risk profile,
the estimates, and the order of work are all different from a greenfield build.

What is genuinely missing is everything *around* the call:

1. The tunnel is manual and its URL changes every restart.
2. Direct-mode replies have multi-second dead air that reads as a dropped line.
3. Nothing answers when someone calls the number back.
4. You can only dial numbers you pre-registered in a config file.

Those four are the actual project.

---

## 1. What exists today

### Architecture

```
   ┌─────────┐   PSTN    ┌────────────┐
   │ Human   │◀─────────▶│   Twilio   │  ConversationRelay
   └─────────┘           └─────┬──────┘  (managed STT + TTS + barge-in)
                               │ WSS  (+ HTTPS status/recording callbacks)
                               ▼
                    ┌──────────────────────┐
                    │ cloudflared Quick    │  ← MANUAL, URL changes per restart
                    │ Tunnel (*.trycloud…) │
                    └──────────┬───────────┘
                               ▼
   ┌───────────────────────────────────────────────┐
   │  voice-mcp `serve` — the Mac, localhost:8790  │
   │  ┌────────────────┐   ┌──────────────────┐    │
   │  │ PublicServer   │   │ AdminServer      │    │
   │  │ 3 routes only  │   │ 127.0.0.1 only   │    │
   │  └───────┬────────┘   └────────┬─────────┘    │
   │          │  RelaySession       │              │
   │          ▼  (1 WS = 1 call)    │              │
   │     ┌─────────────┐            │              │
   │     │ mode=llm    │──▶ OpenRouter              │
   │     │ mode=direct │──▶ (returns; host replies) │
   │     └─────────────┘            ▲              │
   │            sqlite WAL ─────────┘              │
   └───────────────────────────────┬───────────────┘
                                   │ stdio MCP
                                   ▼
                            Claude / Cursor / Warp
```

### Ground truth, with references

| Fact | Where |
|---|---|
| Public surface is exactly 3 routes; everything else 404s | `src/gateway/public-server.ts:121` |
| No inbound voice route exists | same — `/twilio/voice` absent |
| Outbound TwiML built inline, `interruptible: "speech"` | `src/adapters/telephony/twilio-conversation-relay.ts:48-63` |
| Only `textFrame` / `endFrame` builders — **no `play`** | `src/adapters/telephony/relay-messages.ts:83-90` |
| Direct mode short-circuits the LLM loop | `src/gateway/session.ts:137` |
| Mode is read **once**, in the session constructor | `src/gateway/session.ts:39` |
| Dial gate: recipient must be an allowlisted alias | `src/domain/call-requests.ts:37-42` |
| Recording consent is a **separate** concern | `src/domain/consent.ts` (entire file) |
| `publicBaseUrl` is manual config; `serve` refuses without it | `src/config/schema.ts:105`, `src/gateway/gateway.ts:62` |
| No tunnel automation anywhere in `src/` | grep: only comments referencing it |
| 14 MCP tools, two-stage prepare→start | `src/mcp/server.ts` |

### Measured performance (2026-08-02 smoke call, single run)

- `llm` mode warm turn, end-of-turn → first token to Twilio: **p50 ≈ 714 ms**
  (range 651–828 ms). Cold first turn **1429 ms**.
- `direct` mode: **"a few seconds"** per reply — never formally measured.
- No ≥20-turn acceptance run has ever been done. Targets on paper: p50 ≤ 1.0 s,
  p95 ≤ 1.5 s, barge-in stop ≤ 500 ms.

### Two doc-drift items found while reading (small, fix in passing)

- `AGENTS.md` rule 4 points redaction at `src/domain/redact.ts`. **That file no
  longer exists** — it moved to `@george43g/robustness` (`src/log.ts:6`,
  `src/mcp/server.ts:16`). The rule is still correct in spirit; the pointer is dead.
- `HANDOFF.md` says "98 tests across 11 files". Measured today: **93 across 10** —
  consistent with the `redact.ts` + test removal above, not a regression.

---

## 2. Your asks → what's actually needed

| # | You asked for | Reality | Real work |
|---|---|---|---|
| 1 | Agent calls me, we talk back and forth | **Built** (direct mode), proven live | Ergonomics + latency masking only |
| 1b | Keep brief-and-summarise as an option | **Built** (`llm` mode) | Nothing |
| 2 | Formalise the cloudflared hack | Nothing exists; 100% manual | Named tunnel + daemon supervision |
| 3 | Edge function to reduce lag | **Optimises the wrong term** — see §3 | A Worker earns its place for *other* reasons |
| 4 | "Loading" tone during the lag | Not built, but **fully specced** in `HANDOFF.md:96-164`, mechanism confirmed against Twilio's contract | Implement the spec + pick an asset |
| 5 | Inbound calls route back to an agent | No inbound path at all; the number still has Twilio's **factory-default demo webhook** | The largest new build |
| 6 | Remove the "must be pre-approved" dial gate | It's 6 lines | Delete + widen the input type |

---

## 3. Latency: where the time actually goes

**This section is the one I'd most want the planning session to absorb**, because
it contradicts a reasonable assumption in the request.

You asked whether an edge function could cut the lag. For **direct mode — the mode
you actually want — it cannot meaningfully**, because the network is not the
dominant term. Rough budget for one direct-mode reply:

```
  human stops speaking
    │
    ├─  Twilio STT finalises the utterance ................  200–500 ms   (Twilio, fixed)
    ├─  prompt frame → tunnel → Mac gateway ...............   30–120 ms   ← the ONLY part edge touches
    ├─  gateway emits turn.user, long-poll returns ........    5–20 ms
    ├─  ***the agent thinks and writes the reply*** .......  2000–10000 ms ← THE WHOLE PROBLEM
    ├─  voice_say → admin API → WS frame → Twilio .........   30–120 ms   ← edge touches this too
    └─  ElevenLabs TTS first audio ........................  150–400 ms   (Twilio/11L, fixed)
```

Moving the gateway to a Cloudflare Worker attacks **~60–240 ms out of a 2.5–11 s
round trip**. It is a rounding error against the agent's own model turn.

**The honest conclusions:**

1. **Direct-mode lag is irreducible by architecture.** It is the cost of "it's
   really the agent, not a proxy." The 2026-08-02 handoff already accepted this
   trade explicitly. The right response is **masking, not elimination** — which is
   exactly your thinking-tone instinct (§4.2). Your instinct was right and the
   edge-function idea was aimed at the wrong term.
2. **`llm` mode is already fast** (714 ms p50) and doesn't need this.
3. **A Worker still earns its place — for availability, not speed** (§4.1). That's
   a different justification than the one in the request, and it should be argued
   on its own merits rather than smuggled in as a latency fix.
4. **If you want direct mode to *feel* faster**, the levers are behavioural, not
   topological — see §4.4.

> ⚠️ Every number above except the two measured ones is an estimate. A **turn-level
> latency breakdown is the single highest-value measurement** this project is
> missing, and it should be instrumented *before* anyone optimises anything. The
> store already records `endOfTurnMs` / `firstModelTokenMs` / `firstTokenToTwilioMs`
> per turn (`session.ts:127-134`) — direct mode just never fills the last two.

---

## 4. Proposed shape

### 4.1 Transport — named tunnel now, Worker later (and for a different reason)

**The actual pain is not latency, it's churn.** Quick Tunnels mint a new
`*.trycloudflare.com` host every restart, so every restart means: edit
`publicBaseUrl`, restart `serve`, re-point Twilio. That's the "temporary
cloudflared hack" you remember, and it's why it felt like a hack.

**Fix (small, high payoff): a *named* Cloudflare Tunnel** with a DNS route on a
domain you control, e.g. `voice.<yourdomain>`. Stable hostname forever.
`publicBaseUrl` becomes a permanent config value and never changes again. The
daemon supervises `cloudflared` as a child process (start, health-check, restart
with backoff) so "turn voice on" is one command.

**Then, optionally, a Worker as the always-on front door — justified by
availability, not speed:**

- Twilio needs TwiML within ~15 s of an inbound call or the call fails. A Worker
  answers **instantly**, from Cloudflare's edge, even when the Mac is asleep.
- The Worker returns TwiML pointing the media WSS **directly at the Mac tunnel**
  when the Mac is up — so the audio path keeps its current latency and does *not*
  gain a hop.
- When the Mac is down, the same Worker is the natural home for your future
  "backup agent that can answer."
- It's also the right place to serve the thinking-sound asset (edge-cached, and
  Twilio fetches it over the public internet anyway — see §4.2).

That split — **control plane at the edge, media plane direct to the Mac** — gets
the availability win without paying a latency tax on every turn.

### 4.2 Thinking sound (your ask #4)

Already specced end-to-end in `HANDOFF.md:96-164`, including the exact integration
sites, and the mechanism is confirmed against Twilio's ConversationRelay contract:

```json
{ "type": "play", "source": "https://…/thinking.mp3",
  "loop": 0, "preemptible": true, "interruptible": true }
```

`loop: 0` ≈ loop indefinitely; `preemptible: true` means the reply's `text` frame
**auto-replaces it** with no explicit stop; `interruptible: true` means barge-in
kills it. Sites: add `playFrame()` to `relay-messages.ts`; fire it at
`session.ts:137` *before* the direct-mode return; clear on `sendText` (:241),
`handleInterrupt` (:204) and close.

**Worth adding beyond the existing spec** (your framing suggests it):

- **Escalating bed.** A near-silent tone at 0.5 s, something slightly more
  "working" past ~4 s. Silence reads as dropped; a *changing* sound reads as
  progress.
- **Gate it to direct mode only.** `llm` mode replies sub-second; a tone there
  would be noise.
- **Verify empirically** that the `text` frame preempts cleanly with no clipped
  first word. This is the one thing in the spec nobody has tested on a live call.

### 4.3 Inbound — the "NAT router" (your ask #5)

Your analogy is exact: one shared number, many possible agents, so the daemon needs
a translation table keyed on the caller.

**First, the enabling insight: presence is already solvable.** MCP servers can't
push or wake an agent — you're right — but the daemon **already knows which agents
are alive**, because a live direct-mode agent is sitting in a long-poll on
`voice_get_events`. *An open long-poll is a heartbeat.* No new push channel is
needed for the common case.

**Routing ladder, first match wins:**

1. **Explicit reservation.** A new `voice_listen({ scope, ttlSec })` lets an agent
   say "route inbound calls to me." Daemon keeps a registry; the long-poll keeps it
   warm.
2. **Caller affinity (the NAT table).** `(callerE164 → agentSessionId, lastContactMs)`.
   If they're calling back the agent that just called them, and that agent is still
   live, connect them. This is the case that will fire most often and it's the one
   that will feel like magic.
3. **Cold spawn.** Nobody live → daemon launches `claude` in `~`, told to read
   `~/.agents/humans/` + rules and pick up the call.
4. **Backup agent** (future) → a standing `llm` profile answers.

**The hard part is step 3's timing.** Spawning Claude — process start, MCP
handshake, context load — is plausibly **5–20 s**. The caller cannot sit in
silence for that. Which leads to the single most important design consequence:

> **Mid-call mode handoff (`llm` → `direct`) is the primitive that makes both
> inbound cold-start *and* latency masking work.** Answer instantly in `llm` mode
> with a lightweight "receptionist" profile that greets and stalls gracefully, then
> hand the live session to the real agent the moment it attaches.

Today that's impossible: **mode is read once, in the `RelaySession` constructor
(`session.ts:39`), and never re-read.** Making it dynamic is a small change with
large leverage, and it should probably be the first thing built.

**Caller identification is a solved problem in this monorepo — reuse it, don't
rebuild it.** `~/.agents/humans/` already holds per-person relationship files, and
`apps/imsg-mcp` already has the matching logic: `handleKeys()` in
`src/handle-normal.ts` maps a phone number to every variant a file might be indexed
under, and `humans-hints.ts` does the lookup. **Recommendation: promote
`handle-normal.ts` into a shared `@eqstack/*` package** so voice-mcp resolves
"who is calling" with the same normalisation imsg uses. ⚠️ That module carries a
slug-stability warning — `phoneDigits` and `normalizeEmail` feed persisted thread
slugs — so it must move *verbatim*, no "improvements" in transit.

### 4.4 Making direct mode *feel* faster

Given §3, these are the real levers, in rough value order:

1. **Thinking sound** (§4.2) — highest value per unit effort, already specced.
2. **Instant acknowledgement.** The daemon speaks a sub-second filler ("mm-hm",
   "right") from a tiny local model or a canned set the moment the utterance
   finalises, while the agent composes. Needs mid-call handoff (§4.3).
3. **Streamed replies.** `voice_say` currently sends one complete `textFrame(text,
   true)` (`session.ts:243`). If the agent could stream a partial first clause, TTS
   could start seconds earlier. Needs an MCP-side streaming affordance.
4. **Shrink the agent's turn.** Direct-mode replies don't need the agent's whole
   working context. A dedicated small-context sub-agent for phone turns would cut
   the dominant term more than any network change.

---

## 5. Removing the dial gate (your ask #6)

**Agreed, and it's small.** The gate is `src/domain/call-requests.ts:37-42`:

```ts
const recipient = cfg.recipients[input.recipient];
if (!recipient) {
  throw new CallRequestError(
    `unknown recipient alias: ${input.recipient} (recipients are allowlisted in config)`,
  );
}
```

Change: accept **either** a config alias **or** a raw E.164 number. If it's E.164
and unknown, synthesise an ephemeral recipient and dial. Config aliases stay as a
convenience (nicknames, per-person defaults), not a permission system.

**One distinction the planning session should keep straight — they got conflated
in the original design, which is probably why it felt heavy-handed:**

| Axis | What it governs | Verdict |
|---|---|---|
| **Dial allowlist** | May I ring this number at all | **Remove.** You asked to; it's your phone bill and your call. |
| **Recording consent** (`consent.ts`) | May this call be *recorded to disk* | **Different thing.** Australia is an all-party-consent jurisdiction for private conversations in most states. |
| **Two-stage prepare→confirm** | Prevents double-dialling on retry | **Mostly an idempotency key wearing a safety hat** — see below. |

My recommendation: delete the dial gate outright; give ad-hoc numbers
`recordingPolicy: "manual"` (call connects immediately, just doesn't silently
start recording a stranger). That gives you exactly what you asked for — say
"call this number" and it rings — without accidentally creating recordings you
didn't ask for. Trivially overridable if you'd rather ad-hoc numbers default to
recording.

**Also worth collapsing:** the two-stage `prepare` → `start(confirm: true)` flow is
two tool calls plus a token for what should be one instruction. Its *real*
engineering value is `startedCallId` idempotency (a retry returns the existing call
instead of dialling twice — which otherwise means double ringing and double
billing). Recommendation: expose a single `voice_call({ to, objective, mode })`,
keep the idempotency internally by deduping on `(number, objective)` within a short
window. Note `AGENTS.md:16-17` currently calls the two-stage flow "non-negotiable" —
that rule was written under the old posture and this session should consciously
retire it rather than quietly contradict it.

---

## 6. Suggested phasing

| Phase | Contents | Why this order |
|---|---|---|
| **0** | Instrument direct-mode turn latency; fix the two doc-drift items | Measure before optimising — §3's budget is mostly estimates |
| **1** | Remove dial gate; collapse to `voice_call`; named tunnel + daemon supervision | Smallest, highest daily-friction wins; unblocks casual use immediately |
| **2** | Thinking sound | Fully specced; biggest perceived-quality jump; needs a live call to validate preemption |
| **3** | Mid-call mode handoff (`llm` ⇄ `direct`) | The primitive phases 4–5 both depend on |
| **4** | Inbound: `/twilio/voice` route, repoint the number, routing ladder + affinity table, `voice_listen` | The big build |
| **5** | Cold-spawn fallback + receptionist profile | Needs 3 and 4 |
| **6** | Worker front door / backup agent | Only worth it once inbound matters |

Phases 1 and 2 alone probably deliver most of the felt improvement.

---

## 7. Decisions the planning session must make

1. **Tunnel:** named Cloudflare Tunnel on your own domain (recommended) vs.
   automated Quick Tunnel with dynamic re-registration? Named needs a domain +
   one-time setup; Quick stays zero-config but keeps the churn.
2. **Worker front door:** build it (availability + backup agent + edge-served
   audio) or defer? Recommend **defer to phase 6** — it's justified by availability,
   not the latency reason it was proposed for.
3. **Two-stage flow:** collapse to one `voice_call` tool? Recommend **yes**, keeping
   idempotency. Requires consciously retiring `AGENTS.md:16-17`.
4. **Ad-hoc recording default:** `manual` (recommended) or `preconsented`?
5. **Inbound default driver** when nobody is listening: receptionist `llm` profile
   (recommended) vs. straight to cold spawn vs. decline.
6. **Cold-spawn policy:** is the daemon allowed to launch a Claude process
   unattended, and under what caps (max concurrent, rate limit, cost ceiling)?
   This is the one genuinely new operational risk in the whole plan.
7. **Shared handle normalisation:** promote `handle-normal.ts` to `@eqstack/*`
   (recommended) or duplicate a small resolver in voice-mcp? Note the
   slug-stability constraint.
8. **Thinking-sound asset:** synthesised or sourced; where hosted (Mac static
   route vs. Worker/edge vs. Twilio Assets).

---

## 8. Risks and unknowns

- **Twilio-side changes are separate authority from code.** Repointing the number's
  "A call comes in" webhook is a live account change — the number currently still
  answers with Twilio's factory demo greeting. Inbound cannot be tested without it.
- **`play`-frame preemption is unverified on a live call.** The whole thinking-sound
  design rests on `preemptible: true` cleanly yielding to the reply. If it clips the
  first word, the design needs an explicit stop frame.
- **Cold spawn is unbounded cost.** An inbound call that launches a Claude instance
  is a stranger triggering paid compute on your machine. Caps are not optional here.
- **Direct mode has no LLM mediating what gets spoken** (`AGENTS.md:39-45`). Removing
  the dial gate widens *who* can be reached this way. Worth a conscious nod, not a
  gate.
- **Twilio API-key health-check trap** (`HANDOFF.md`): API keys return **401 on the
  Account resource** by design but 200 on resource endpoints — probe a resource
  endpoint or a healthy key looks dead.
- ⚠️ **Outstanding from the previous cycle: the Twilio `SK…` secret leaked into an
  agent transcript and rotation is still pending — George-only action.** Anything
  touching Twilio credentials should assume the value changes.
- **No ≥20-turn acceptance run has ever been done.** All latency claims rest on one
  smoke call.

---

## 9. What I'd want a reviewer to argue with

Three places this brief could be wrong, listed so the planning session attacks them
rather than inheriting them:

1. **"Edge won't help."** If direct-mode replies turn out to be ~1 s rather than
   2–10 s, the fixed network costs stop being a rounding error and §3 flips. Phase 0
   settles it. I'd rather be corrected by a measurement than believed.
2. **"Mid-call mode handoff is the key primitive."** Reasonable alternative: keep
   modes static and make the *receptionist* a separate call leg that transfers.
   Messier in Twilio, but avoids mutable session state.
3. **"Reuse `handle-normal.ts`."** The slug-stability coupling is real; a reviewer
   could argue voice-mcp should own a small independent resolver rather than take a
   dependency on a module that must not change.
