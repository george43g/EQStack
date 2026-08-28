# LATER phases — H onward (sketch, not plans)

**Read order:** [`WORKSTREAM.md`](./WORKSTREAM.md) → [`DECISIONS.md`](./DECISIONS.md) →
this file → your own `PHASE-*.md` (which does not exist yet for anything here).

## What this file is

Pass 1 is A–G plus the S spike. **Everything after that lives here as a sketch** so
the arc survives context compaction: a phase agent that reads only its own file
would rebuild the shape of the workstream from scratch and get it slightly wrong.

Each section is goal / key dependency / main risk / what blocks it. **None of these
is a plan.** When a phase is scheduled, it gets its own `PHASE-*.md` opening with
`## Inherited invariants`, and *that* file supersedes the sketch here.

Source of truth for this material is Appendix A of the approved plan
(`~/.claude/plans/glowing-percolating-key.md`, appended 2026-08-29). Where this file
and Appendix A disagree, Appendix A is correct.

---

## Carried forward from Appendix A — facts every later phase needs

### ElevenLabs Agents capabilities (verified from live tool schemas, 2026-08-29)

Anchored in D-19 / D-20. Re-read the API reference before implementing; the shape
below is settled but the parameter details are not this document's to guarantee.

| Capability | Parameter | Why it matters here |
|---|---|---|
| Create an agent from **one prompt** | `agents_create`: `prompt`, `voice_id`, `language`, `first_message` + raw-`body` escape hatch | "AI sends one long prompt" is the *intended* path, not a shortcut |
| Agent calls **our MCP server as a tool source** | `agents_create_mcp_server`, transport `SSE \| STREAMABLE_HTTP` | The consult loop (mode 3) is first-class, not a hack |
| Tool calls may block **5–300 s** | `response_timeout_secs` (min 5, max 300) | A whole agent turn fits inside one tool call |
| Agent **speaks while waiting** | `pre_tool_speech: auto \| force \| off` (`auto` decides from recent tool latency) | Native latency masking, tuned by Phase E's real numbers |
| Built-in **thinking sounds** | `tool_call_sound: typing \| elevator1-4`, `tool_call_sound_behavior: auto \| always` | Modes 2/3 get Phase F's feature free |
| Barge-in control during a stall | `interruption_mode: allow \| disable_during_tool \| disable_during_tool_and_turn` | Stops the callee talking over a mid-lookup pause |
| Async / deferred tools | `execution_mode: immediate \| post_tool_speech \| async` | Long lookups without blocking the conversation |
| Tool output → agent state | `DynamicVariableAssignment` (`value_path`, `preserve_native_type`) | Our answer becomes a variable the agent reasons over |
| **ElevenLabs can own the number** | `agents_list_phone_numbers`, `TelephonyProvider: twilio \| sip_trunk \| exotel` | Modes 2/3 keep the laptop out of the media path entirely |

### The number-contention constraint

⚠️ **One Twilio number = one inbound handler.** A number points at ElevenLabs *or*
at our ConversationRelay gateway, never both. So mode 1 + inbound (L–M) and modes
2/3 (Q/R) **contend for the same number**. Options: a second Twilio number, or our
gateway owns the number and bridges to ElevenLabs per call. This is **O-1, and it
blocks Phase Q outright** — do not start mode-2 work without George's answer.

### The routing principle (INV-7, applies to every phase below)

> The orchestrator sits at the **end** of the chain, never in the media path.

Before building any call path, draw its hop diagram and delete every hop that exists
only because the laptop was in the way.
✅ `laptop (commands) → OpenRouter → ElevenLabs → Twilio`
❌ `OpenRouter → laptop → ElevenLabs → cloudflare → laptop → Twilio`

### Recommended reordering

**Pull P (local audio) forward, ahead of everything else in this file.** It is dev
infrastructure, not a feature — see §P for the honest limits of that claim.

---

## H — daemon MCP-over-HTTP + WS + client SDK

**Goal.** The daemon serves the command registry over HTTP so anything that is not
the stdio MCP process can drive it: the SDK, the SPA, a second machine on loopback.
Two channels — **MCP-over-HTTP** (`@george43g/mcp-kit` Streamable HTTP transport)
for commands, **WS** for live event streams. Both are thin adapters over Phase B's
registry (INV-5); adding an operation to the registry must add it here for free.

**Key dependency.** Phase B's registry and Phase D's supervised daemon. `mcp-kit` is
not yet a dependency of this app (`apps/voice-mcp/package.json` has robustness, MCP
SDK, commander, ws, zod) — Phase A adds it.

**D-12 is load-bearing here: the published package IS the app.** SDK exports and the
`tel` bins ship from one package, not a `-sdk` sibling. Anyone proposing a second
package is reversing a settled decision and owes a `DECISIONS.md` row.

**Main risk.** The HTTP surface drifting from the stdio surface — exactly the
duplication R-7 rejected. Mitigation is structural (INV-8): SDK types are *generated
from* the registry, never hand-maintained.

**Blocked by.** Nothing open. INV-10 applies: MCP-HTTP and WS bind `127.0.0.1` and
are never routed through the tunnel.

---

## I — TUI

**Goal.** A full-screen live view of calls in flight — both sides of the
conversation, speaker-labelled, with Phase E's per-turn latency. Built on
`@george43g/tui-kit@0.5.1`.

**Key dependency.** Phase G. G's event-stream parsing and rendering primitives are
the seam; I is a second renderer over the same primitives, **not a second parser**.
If Phase I finds itself re-parsing the event stream, G left the wrong seam and the
fix is in G.

**Main risk.** The imsg TUI's two hard-won invariants apply here too and are cheap
to re-learn expensively: `NODE_ENV=production` before the first Ink import, and the
chunked-keystroke law (Ink delivers a paste as one `useInput` call). See the imsg
`CLAUDE.md` § TUI invariants rather than rediscovering them.

**Blocked by.** Nothing open.

---

## J — web SPA

**Goal.** A browser view of the same thing, consuming the Phase H SDK, **served from
the daemon on loopback**. Same data, third renderer.

**Key dependency.** Phase H's SDK and WS channel. J writes no protocol of its own.

**Main risk.** Scope creep from "view" into "control panel with its own state".
INV-9 (single WAL writer) means the SPA mutates only through the loopback API. Also
INV-11: the SPA is a rendering surface for redacted payloads — full phone numbers
must never reach the browser.

**Blocked by.** Nothing open.

---

## K — mid-call mode handoff

**Goal.** Change a live call's mode after it has started: answer instantly in a
lightweight receptionist mode, hand off to the real agent when it attaches.

**This is the load-bearing one.** `mode` is read **exactly once**, in the
`RelaySession` constructor —
`this.mode = service.store.getCallRequest(call.requestId)?.mode ?? "llm"`
(`src/gateway/session.ts:39`) — and never re-read anywhere in the session. Making it
dynamic is a small change with disproportionate leverage: it is the primitive under
**both** inbound cold-start (answer now, attach the real agent in 5–20 s) **and**
instant-acknowledgement latency masking (a sub-second filler while the agent
composes).

**Key dependency.** Phase B's open `CallMode` union — mode handoff between four
modes is meaningless if the type still holds two. Phase F's thinking-state lifecycle
is reused rather than re-invented (WORKSTREAM seam map, row F).

**Main risk.** Mutable session state. The brief names the alternative honestly: keep
modes static and make the receptionist a **separate call leg that transfers**
(`../2026-08-24-two-way-voice-brief.md:412-414`). Messier in Twilio, but no mutable
state. A phase agent that finds mutable mode genuinely nasty is allowed to take the
transfer route — with a `DECISIONS.md` row.

**Blocked by.** O-2 (mode names) indirectly, via Phase B.

---

## L–M — inbound

**Goal.** Someone rings the number and reaches an agent.

**Today there is no inbound path at all.** The public listener accepts exactly two
HTTP routes — `path !== "/twilio/status" && path !== "/twilio/recording"` → 404
(`src/gateway/public-server.ts:118-125`) — plus the `/relay/<token>` WebSocket
upgrade (`:72-97`, regex at `:79`). `/twilio/voice` does not exist. And **the Twilio
number still carries Twilio's factory-default demo webhook**, so today an inbound
call reaches a Twilio greeting, not us.

**Three separable pieces.**

1. **The route.** A signature-validated `POST /twilio/voice` returning
   `<Connect><ConversationRelay>` TwiML. Signature validation is not optional —
   INV-10, and the existing `validateTwilioSignature` call sites (`:83-91`, `:131-143`)
   are the pattern to copy verbatim.
2. **Repointing the number.** A **live Twilio-account change**, which is *separate
   authority from placing calls* — INV-14 covers paid calls; this is George changing
   his account's configuration. Inbound cannot be tested until it happens, and it
   breaks nothing until it does.
3. **The routing ladder**, first match wins:
   1. **Explicit reservation** — `listen_for_calls({ scope, ttlSec })` (INV-1: not
      `listen`). An agent says "route inbound to me".
   2. **Caller affinity — the "NAT table".** `(callerE164 → agentSessionId,
      lastContactMs)`. Someone ringing back the agent that just called them gets
      that agent. This fires most often and is the case that feels like magic.
   3. **Cold spawn** — nobody live, so launch a Claude process. **D-16: allowed with
      HARD CAPS.** Max concurrent, rate limit, cost ceiling. A stranger triggering
      paid compute on George's machine is the one genuinely new operational risk in
      the whole workstream; caps are not a nice-to-have.
   4. **Backup agent** (future) — a standing profile answers. Natural home is Phase N.

**The insight that must not be lost: an agent sitting in a long-poll IS a
heartbeat.** MCP servers cannot push to or wake an agent — but the daemon already
knows which agents are alive, because a live direct-mode agent is blocked in a
long-poll on the events tool. **Presence needs no new push channel.** Anyone
proposing one has missed this.

**Caller identification: reuse, don't rebuild.** `apps/imsg-mcp/src/handle-normal.ts`
already maps a phone number to every variant a `~/.agents/humans/` file might be
indexed under (`handleKeys()` at `:107`), and imsg's `humans-hints.ts` does the
lookup. Promote it to a shared `@eqstack/*` package. ⚠️ **That module must move
verbatim** — its own header warns that `phoneDigits` and `normalizeEmail` feed
`identityKey` and therefore persisted thread slugs, and that changing either
"rotates EVERY slug in slugs.db" (`apps/imsg-mcp/src/handle-normal.ts:13-26`). No
"improvements" in transit. The counter-position is recorded in the brief
(`../2026-08-24-two-way-voice-brief.md:415-417`): voice could own a small
independent resolver instead. Either is defensible; silently editing the shared
module is not.

**Main risk.** Cold-spawn timing. Process start + MCP handshake + context load is
plausibly 5–20 s and the caller cannot sit in silence — which is exactly why K comes
first.

**Blocked by.** O-1 (number contention — inbound and mode 2 want the same number),
O-5 (cost ceiling, before unattended inbound may use modes 2/3), and George on
repointing the number.

---

## N — Cloudflare Worker front door

**Goal.** An always-on edge front door: instant TwiML on an inbound call even when
the Mac is asleep, a host for the backup agent, and the edge-cached home for the
thinking-sound asset.

**Justified by AVAILABILITY, explicitly not latency.** D-18 and R-1 settle this: a
Worker attacks ~60–240 ms of a 2.5–11 s direct-mode round trip, and the dominant
term is the agent's own model turn, which no topology change touches. **If a future
phase file justifies N by speed, it is re-proposing R-1 and is wrong.**

**Key dependency.** L–M. A front door with nothing behind it is not worth building —
"only worth it once inbound matters".

**Main risk.** Violating INV-7 by putting the Worker in the media path. The split is:
**control plane at the edge, media plane direct to the Mac.** The Worker returns
TwiML pointing the media WSS at the Mac tunnel; audio does not gain a hop.

**Blocked by.** Nothing open, but strictly after L–M.

---

## P — local audio device (speakers + mic)

**Goal.** One capability, four uses: **listen in** on a live call; **type hints**
into a live call; **speak hints** (human talks to the laptop mic, an agent relays);
and **call the laptop instead of the phone** — an agent "rings" the local machine
and talks through speakers and mic.

**Recommend pulling this early — ahead of H.** The fourth use removes a paid PSTN
call from a large part of every test cycle, so it is dev infrastructure that
de-costs every phase after it.

**Honest limit on that claim, so nobody over-trusts it.** A local-audio call does
**not** traverse Twilio, so it exercises none of the things that actually break:
TwiML validity, signature validation, STT finalisation timing, barge-in behaviour,
`play`-frame preemption (O-7). It de-costs *agent-loop and UI* iteration, not
*telephony* verification. Live paid calls stay necessary for the telephony seams —
budget for them anyway.

**Key dependency.** Listen-in with real audio depends on the S spike's answer. If S
is negative, P's listen-in is **text rendering only** and should be planned that way
from the start rather than discovered late.

**Main risk.** Reaching for a heavyweight native audio dependency. Prefer the
zero-dep macOS route the monorepo already favours (imsg's `src/media.ts` is the
precedent: `sips`/`qlmanage`/`mdls`, no npm audio stack).

**Blocked by.** Nothing open; informed by S.

---

## Q — mode 2: briefed ElevenLabs agent

**Goal.** Provision an ElevenLabs agent from a brief (one prompt is the intended
path), let it hold the whole call, and return transcript + a terminal "call over"
flag to the originating agent through the same long-poll pattern used today.

**Key dependency.** Phase B's open `CallMode`. Also D-20: ElevenLabs holds the
Twilio number natively, so the laptop is out of the media path entirely — the tunnel
is still needed, but only for the low-frequency tool channel.

**Main risk.** **O-1 blocks this outright.** One number, one handler: mode 2 and
mode-1 inbound cannot both own the number. Do not start until George picks second
number vs gateway-bridges-per-call. Secondary risk is O-5 — EL agent minutes bill on
top of Twilio.

**Blocked by.** O-1 (hard), O-5 (before unattended use).

---

## R — mode 3: EL agent + consult callback

**Goal.** Mode 2 plus a consult loop. The EL agent hits something the brief does not
cover, calls **our** MCP server as a tool, the tool blocks and queues the question,
the local agent's long-poll returns it, the local agent answers, the tool returns,
the EL agent speaks it. The callee hears no dead air because `pre_tool_speech` and
`tool_call_sound` cover the gap.

**Key dependency.** Phase H (EL calls our https MCP endpoint — `url` must be https,
so Phase D's stable hostname is a hard prerequisite), Phase E (`response_timeout_secs`
must be tuned to the originating agent's *measured* turn time, not a guess — this is
the seam-map row E→R), and Q.

**Main risk.** Timeout mismatch. `response_timeout_secs` caps at 300 s but a direct
agent turn is 2–10 s; setting it from folklore instead of Phase E's numbers produces
either premature failures or a call that stalls for minutes. Configure
`approval_policy: auto_approve_all`, `pre_tool_speech: force`,
`tool_call_sound: typing` per Appendix A.3.

**Direction of travel worth recording (A.6, horizon not scheduled):** a **digital
twin** — George's cloned voice plus his data sources behind a mode-3 agent, taking
calls as him and *never guessing*: any decision or unknown becomes an immediate
consult back to him. It changes what "good" means for this consult loop — the bar is
**"asks rather than invents"**, not "answers smoothly".

**Blocked by.** O-1 (via Q), O-5.

---

## T — mode 4: OpenRouter model, ElevenLabs as TTS only

**Goal.** Any OpenRouter model conducts the call with ElevenLabs supplying voice
only. Fast-model / low-effort presets; per-call model selection.

**Key dependency.** Phase C — every mode dials through the one-shot `call` command
(seam map row C). Wiring follows INV-7 directly:
`laptop (commands) → OpenRouter → ElevenLabs → Twilio`.

**Main risk.** Drifting into "mode 1 with a different brain" and duplicating the
session loop. The existing `llm` mode already is an OpenRouter-driven call; T is
mostly *model selection and presets* on top, plus routing that keeps the laptop out
of the media path. Check the hop diagram before writing code.

**Blocked by.** O-3 — the OpenRouter scoped key is a live secret-provisioning action
needing George's authorisation at the time, stored by name per INV-12.

---

## U — two skills

**Goal.** (a) How to use this MCP — the tool surface, the modes, what to do when a
call stalls. (b) How to wire calls with the ElevenLabs and Twilio CLIs, covering
call-relevant features only.

**Key dependency.** Phase B's registry, so skill (a) is generated or checked against
the real surface rather than hand-written and stale (INV-8).

**Main risk.** ⚠️ **O-4: an ElevenLabs CLI's existence is unverified.** Verify before
promising one. If there is none, skill (b) covers the ElevenLabs **API** plus the
Twilio CLI and says so plainly — do not describe commands that may not exist.

**Blocked by.** O-4 (implementer verifies; cheap).

---

## V — hint channel

**Goal.** Two stages. **Typed hints** — George types into console/TUI/web and the
text reaches a live call. **Spoken hints** — George talks to the laptop mic and an
agent relays it onto the call, which needs two linked ElevenLabs streams.

**Key dependency.** Typed hints need Phase H's WS channel plus a hint command in the
registry. Spoken hints need Phase P's mic capture.

**Main risk.** INV-4 — in direct mode there is no LLM mediating speech; whatever
reaches the call is spoken verbatim to a real person. A hint channel is a **second**
path to that microphone. Its authorisation and redaction story needs stating
explicitly, not inheriting by accident. Spoken hints additionally need a turn-taking
answer: who yields when George and the agent talk at once.

**Blocked by.** Nothing open, but the INV-4 question above should become a
`DECISIONS.md` row before implementation.
