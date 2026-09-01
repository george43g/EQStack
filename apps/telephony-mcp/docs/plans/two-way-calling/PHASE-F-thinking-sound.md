# PHASE F — thinking sound

> Read [`WORKSTREAM.md`](./WORKSTREAM.md) then [`DECISIONS.md`](./DECISIONS.md) first.
> **Runs after Phase E, never beside it** — both edit `src/gateway/session.ts`
> (WORKSTREAM.md "Parallelism rules").
>
> **Paths** are relative to the app dir (`apps/telephony-mcp/` after Phase A).
> Line numbers are against the tree as read on 2026-08-29.

**The spec already exists.** [`../../../HANDOFF.md:96-164`](../../../HANDOFF.md)
specifies this feature end to end, including the exact integration sites, and
states the mechanism is confirmed against Twilio's ConversationRelay contract.
This phase **implements that spec**; it does not redesign it. The two additions
beyond it are an escalating bed and a direct-mode gate, both from the brief
(`../2026-08-24-two-way-voice-brief.md:221-229`).

---

## Inherited invariants

| INV | How it binds this phase |
|---|---|
| **INV-4** | Direct mode has no LLM mediating speech. The bed is audio played to a real person on a live line: it must be gate-able off from config and must never play over the caller. |
| **INV-6** | The `voice.thinkingSound` config block is a Zod schema in `src/config/schema.ts` (`.strict()`, like every sibling block), not an ad-hoc read. |
| **INV-10** | *The* tension of this phase. "Public surface stays minimal and signature-validated… **Adding a public route requires a `DECISIONS.md` entry.**" Twilio's fetch of `source` cannot carry `X-Twilio-Signature`. See [Serving the audio](#serving-the-audio-the-inv-10-tension). |
| **INV-11** | "Never log or store secret values, **tunnel URLs**, or recording plaintext" (`AGENTS.md:29-31`). The `play` frame's `source` embeds the tunnel hostname — so **no event, log line or metric may carry the source URL.** Emit an asset id / stage number instead. |
| **INV-14** | Steps 1–8 are offline with the fake-WS harness. Step 9 is a paid call and George authorises it at the time. |
| **INV-16** | One merge at a time. |

---

## Scope

1. `playFrame()` builder beside `textFrame` / `endFrame`
   (`src/adapters/telephony/relay-messages.ts:82-91`).
2. A thinking-state lifecycle on `RelaySession`: start, escalate, clear.
3. `voice.thinkingSound` config block, **direct mode only**.
4. A two-stage escalating bed (near-silent → slightly "working").
5. A serving decision for the audio asset that survives INV-10.
6. The live check of **O-7** — the design's one untested assumption.

## Non-goals

- No llm-mode bed. Warm llm turns are ~714 ms measured
  (`../2026-08-24-two-way-voice-brief.md:99-101`); a tone there is noise.
- No filler *speech* ("mm-hm"). That is brief §4.4 item 2 and needs mid-call
  handoff (Phase K).
- No mode mutability. Read `this.mode` at fire time so K gets it for free, but
  do not make it settable here.
- No new latency work — Phase E already produced the numbers this phase consumes.

---

## The mechanism (verbatim from the existing spec, not re-derived)

```json
{ "type": "play", "source": "https://…/thinking.mp3",
  "loop": 0, "preemptible": true, "interruptible": true }
```

| Field | Meaning per `HANDOFF.md:112-116` |
|---|---|
| `loop: 0` | plays up to 1000 times — effectively "loop until replaced" |
| `preemptible: true` | the **next app message replaces** it — the existing reply `text` frame auto-preempts, no explicit stop needed |
| `interruptible: true` | caller barge-in stops it |

**Do not extend this JSON from memory.** If the implementation needs anything
beyond these four fields — a stop/clear message, a volume field, a codec
constraint, a `preemptible` interaction with partial `text` frames — that is
**unknown; verify against Twilio's ConversationRelay WebSocket-messages doc**
(<https://www.twilio.com/docs/voice/conversationrelay/websocket-messages>) and
record what you find here before coding against it. Step 1 exists for exactly this.

---

## Serving the audio: the INV-10 tension

Twilio fetches `source` over the public internet, and that fetch **cannot carry
an `X-Twilio-Signature`** — so the asset URL is, by construction, an
unauthenticated public GET. INV-10 says the public surface stays minimal and
signature-validated. These cannot both hold for an asset we host.

| Option | INV-10 cost | Other cost |
|---|---|---|
| **(a)** static `GET /thinking-sound.<ext>` on the public listener (`public-server.ts:118-125`) | **Adds an unauthenticated public route** — needs a `DECISIONS.md` row, per INV-10's own escape clause | zero new infra; asset ships with the package |
| **(b)** Twilio Assets / any public URL | **none — the public surface does not grow** | one manual upload; asset lives outside the repo |
| **(c)** Cloudflare Worker / R2 (Phase N's front door) | none | doesn't exist yet; would couple F to N |

**Recommendation: (b) as the default, (a) as an opt-in that ships off.** The
honest resolution of the tension is *not to host the file at all* — INV-10 is
satisfied by keeping the route count at three, not by arguing that one more
static route is harmless. Config takes a `url`; if it is unset, the feature is
off. `serve` refuses to enable the built-in route unless
`voice.thinkingSound.serveLocally: true` is explicitly set.

If (a) is chosen anyway, the route must be: one fixed path (no path parameter,
no traversal surface), one static file read once at boot, `Cache-Control:
public, max-age=…`, method `GET` only, and it must be matched **before** the
`/relay` upgrade handler can ever see it (`public-server.ts:72-97`) so it cannot
shadow the signed WS path. The existing "everything else 404s" tests must be
extended, not weakened.

> **Proposed DECISIONS row (this phase must land it before merging option (a)):**
> *"D-nn — thinking-sound asset is served from `<host>`; the gateway's public
> route count stays at three / grows to four because …"* INV-10 requires the row;
> writing the code first and the row later is the failure mode the invariant exists to prevent.

---

## Steps

### 1. Verify the contract, in writing (no code)

Re-read Twilio's ConversationRelay WebSocket-messages doc. Record in this file:
the exact `play` field list and types; whether a stop/clear message exists;
what happens to a `preemptible` play when a `text` frame with `last: false`
arrives (llm mode streams token-by-token — irrelevant while the bed is
direct-only, but Phase K will make it relevant); accepted audio formats and any
size/duration limit. **If the doc contradicts `HANDOFF.md:107-116`, the doc
wins** and the disagreement goes in `DECISIONS.md`.

### 2. `playFrame` builder (`src/adapters/telephony/relay-messages.ts`)

Add beside `textFrame` (`:83-85`) and `endFrame` (`:87-91`):

```ts
export function playFrame(
  source: string,
  opts: { loop?: number; preemptible?: boolean; interruptible?: boolean } = {},
): string
```

Same shape as the neighbours: returns a JSON string, no I/O, no logging. Defaults
`{ loop: 0, preemptible: true, interruptible: true }`. The file's inbound half is
Zod-parsed (`:47-53`); outbound builders are plain functions — keep that split.

### 3. Config (`src/config/schema.ts`)

Add to the existing `VoiceSchema` block:

| Key | Type | Default | Why |
|---|---|---|---|
| `enabled` | bool | `false` | ships off; INV-4 says this must be switchable |
| `url` | https URL | — | stage-1 asset; unset ⇒ feature off regardless of `enabled` |
| `escalateUrl` | https URL, optional | — | stage-2 asset; unset ⇒ no escalation |
| `startDelayMs` | int | from Phase E | don't play under a reply that arrives first |
| `escalateAfterMs` | int | `4000` | brief §4.2 ("past ~4 s") |
| `maxLoopSec` | int | `30` | hard stop; the line should not hum forever |
| `serveLocally` | bool | `false` | gates option (a) above |

`startDelayMs` **must be chosen from Phase E's measured `voice_direct_turn_ms`
p10**, not guessed. A bed that starts at 0 ms when replies land in 700 ms is a
regression, not a feature.

### 4. Thinking state on `RelaySession` (`src/gateway/session.ts`)

One private box, sharing Phase E's `pendingDirect` turn context:

```
thinking: { turn: number; stage: 1 | 2; startTimer; escalateTimer; maxTimer } | null
```

Fire it in `handleTurn` **before** the direct-mode `return` at `:137`, exactly
as the spec says. Do not send the frame inline — arm a `startDelayMs` timer
(`.unref()`, like every other timer in this codebase, e.g.
`call-service.ts:190`) so a fast reply pre-empts the bed by never starting it.

| Trigger | Action |
|---|---|
| `startDelayMs` elapses, turn still pending | send stage-1 `playFrame`, arm `escalateAfterMs` and `maxLoopSec` timers, emit `thinking.started` |
| `escalateAfterMs` elapses | send stage-2 `playFrame` (which preempts stage 1 by the same `preemptible` rule), emit `thinking.escalated` |
| `sendText` (`:241-259`) | clear all timers **before** `ws.send` (`:243`); emit `thinking.stopped { reason: "reply" }` |
| `handleInterrupt` (`:204-222`) | clear; `interruptible:true` already stopped the audio; emit `reason: "barge_in"` |
| a new `handleTurn` | clear the previous turn's state before arming the new one |
| `end` (`:261-271`) and `ws.on("close")` (`:55-60`) | clear timers; never send on a closed socket |
| `maxLoopSec` | see Step 6 |

Gate every fire on `this.mode === "direct"` **read at fire time** — do not
snapshot a boolean in the constructor (`:39` is where mode is read once today;
Phase K makes it mutable and a cached copy would silently go stale).

### 5. Escalation, and the risk it multiplies

Two assets, stage 2 sent as a second `play` that preempts the first. This reuses
the exact preemption mechanism the whole design rests on — which means **if O-7
turns out badly, escalation makes it worse**, because it doubles the number of
preemption events per turn. Ship stage 2 behind its own config key
(`escalateUrl` unset ⇒ single-stage) so it can be disabled without disabling the
feature.

### 6. `maxLoopSec` behaviour

The spec leaves this open (`HANDOFF.md:163`). Default: **stop, go silent, emit
`thinking.timeout`.** A bed that outlasts 30 s is masking a failure, and silence
plus a visible event is more honest than a hum. A spoken "still here" needs
INV-4 consideration (it is unmediated speech to a real person) — do not add one
here.

### 7. Events (`src/gateway/session.ts`)

`thinking.started | .escalated | .stopped | .timeout`, each carrying
`{ turn, stage, reason? }`. **No `source` URL, ever** (INV-11 — it embeds the
tunnel host — `AGENTS.md:29-31`). These are what Phase G renders as a "thinking" marker between the
caller's line and the reply.

### 8. Tests (`tests/gateway.integration.test.ts`)

The spec's own list (`HANDOFF.md:149-156`) plus what the state machine adds. The
existing direct-mode describe block (`:372-441`) and `FrameCollector` (`:68-80`)
give this for free.

| # | Assertion |
|---|---|
| 8.1 | Direct-mode `turn.user` + `startDelayMs` elapsed ⇒ exactly one `play` frame, `loop:0, preemptible:true, interruptible:true`. |
| 8.2 | A reply inside `startDelayMs` ⇒ **zero** `play` frames. |
| 8.3 | After `say`, the `text` frame follows and no further `play` frames are sent; the frame **order** is asserted (play … then text). |
| 8.4 | `llm` mode emits no `play` frames, ever. |
| 8.5 | Barge-in clears the state; a later reply does not resurrect the bed. |
| 8.6 | `end` / socket close cancels pending timers — no send after close, no open handle left (this suite runs with real timers). |
| 8.7 | `escalateUrl` unset ⇒ never more than one `play` per turn. |
| 8.8 | `maxLoopSec` ⇒ `thinking.timeout`, no further frames. |
| 8.9 | No event, and no log line, contains the asset URL. |
| 8.10 | If option (a) is implemented: the asset route serves the file, and every other public path still 404s / 403s. |

### 9. **O-7 — the live check (paid, George-authorised)**

**Say it plainly: nobody has ever verified that a `preemptible` play frame yields
to the reply `text` frame without clipping the first TTS word.** The whole design
rests on it (`DECISIONS.md` O-7; brief `:386-388`). It cannot be tested offline —
the fake WS proves *we sent the right frames*, not *what the callee heard*.

Procedure: one direct-mode call to George, recording on (`george` is
`preconsented` in config), ≥6 turns. Per turn, let the bed play ≥2 s, then reply
with a reply whose **first word is distinctive and short** ("Right, …",
"Okay, …") so a clipped onset is audible. Listen back to the recording (`tel
recording play <sid>`, `cli.ts:292-313`) rather than judging live.

| Outcome | Consequence |
|---|---|
| Clean preemption | Close O-7 as Settled with the call id as anchor. Ship as specced. |
| First word clipped | **Design changes.** Send an explicit stop (Step 1 tells us whether one exists) or a 1-shot silent `play`, then wait a measured gap before the `text` frame. That gap is added latency on every turn and must be measured with Phase E's `voice_direct_egress_ms`, not guessed. |
| Bed doesn't stop on barge-in | `interruptible:true` is not doing what the spec claims — re-open the mechanism, not the integration. |

Record the outcome in this file **and** move O-7 out of `DECISIONS.md#Open`.

---

## Verification

1. `pnpm --filter telephony-mcp test typecheck lint`; root `pnpm verify`.
2. Public-surface check: with `serveLocally: false` the route table is unchanged
   from `public-server.ts:118-125`.
3. Log check: `rg` the diff for the asset URL reaching `logger` or an event payload.
4. PR → CI → merge → **wait for the Release run** (INV-16).
5. Step 9 after merge, separately authorised. **Do not mark the phase complete on
   green tests alone** — the tests assert frames, and the open question is audio.

---

## Seam left behind

| Artifact | Consumed by |
|---|---|
| `playFrame()` in `relay-messages.ts` | **K** (receptionist stalls), any future non-speech audio, **S** if the audio spike needs a probe tone |
| The thinking-state machine (arm → escalate → clear, keyed on a pending turn) | **K** — mode handoff reuses exactly this shape: "cover the gap, clear on the real thing arriving" (WORKSTREAM.md seam map) |
| `thinking.*` events | **G** (live marker), **I**/**J** |
| A settled answer to O-7 | **K**, and anything that ever preempts a live frame |
| The asset-hosting decision | **N** (Worker front door is the natural home — brief `:199-200`) |

**Blast radius:** `relay-messages.ts` (+1 exported function, additive),
`session.ts` (state machine + 4 call sites), `config/schema.ts` (+1 optional
block, defaults off), optionally `public-server.ts` (+1 route — gated,
DECISIONS-row-bearing), tests. **Ships off by default**, so the merge is inert
until config turns it on; that is the rollback.

---

## Open questions

| # | Question | Who | Note |
|---|---|---|---|
| **O-7** (existing, this phase's core risk) | Does a `preemptible` play yield to the reply `text` frame with no clipped first word? | implementer, paid test | Step 9. Unverified on a live call. Every other step is cheap; this one decides whether the design is right. |
| **O-11** (proposed) | Where does the asset live — package + local static route, Twilio Assets, or Worker/R2? | George | Brief §7.8 (`:375-377`) lists it as a decision the planning session owed; it is not in `DECISIONS.md`. INV-10 forces the answer to be recorded before option (a) ships. |
| **O-12** (proposed) | What *is* the asset? Synthesised or sourced; must stay pleasant through an 8 kHz phone codec and loop seamlessly. | George (taste) | A bad bed is worse than silence. Two candidates, judged on a real call in Step 9, not in headphones. |
| — | Does ConversationRelay send an `interrupt` frame when the caller talks over a **play** (as opposed to over TTS)? | implementer | **unknown — verify** in Step 1. If it does not, `handleInterrupt` never fires for the bed and the next `prompt` is the only clear signal; Step 4's "a new `handleTurn` clears" covers that, but the event stream would show no barge-in marker. |
| — | Does the bed fire on the **first** turn, before any reply has ever been sent? | implementer | It should — the first turn is the coldest (llm cold turn was 2× warm). Confirm it does not collide with the greeting TwiML (`twilio-conversation-relay.ts:48-63`). |
