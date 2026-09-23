# ElevenLabs in real time — what exists, what it costs, how we build on it

> **Read this before designing any mode where ElevenLabs (EL) holds a call** —
> consult (Phase R), group meetings (O-29), inbound (L–M), local audio (P).
> Written 2026-09-23 after the first live delegate call (D-83) showed that
> polling `GET v1/convai/conversations/{id}` returns an **empty transcript until
> the call ends**. Decisions that follow from it are D-84…D-86 and O-33 in
> `DECISIONS.md`. Sources were researched by two read-only agents and the
> load-bearing ones re-checked by the top-level session; each claim is marked
> **verified** (source quoted) or **believed** (inferred, not tested).

## The answer in one paragraph

EL has **three** real-time surfaces, and which one you get depends on **who
carries the audio**, not on which endpoint you call. REST (`/v1/convai/*`) has
**nothing live** — no endpoint messages, steers or ends a live conversation.
When EL carries the audio itself (native Twilio integration — what delegate
mode does today), the only live view is the **monitor WebSocket**, which is
**enterprise-only**; this workspace is on the **starter** tier. When *we* carry
the audio to EL — a laptop mic, a browser page, or our own bridge from a
Twilio media stream — we hold EL's **conversation WebSocket** and receive every
transcript and response event live, and can inject context, on any plan.

## The three surfaces

| Surface | Who carries audio | Live events | Push into the call | End the call | Plan |
|---|---|---|---|---|---|
| **REST** `/v1/convai/conversations/{id}` | anyone | **none** — transcript is `[]` until `done` (measured, D-83) | no | no | any |
| **Monitor WS** `wss://api.elevenlabs.io/v1/convai/conversations/{id}/monitor` | EL (native Twilio) | transcripts, agent responses, corrections; ~last 100 cached; may arrive out of order | `contextual_update`, `transfer_to_number`, human takeover (chat) | **`end_call`** | **Enterprise, or the `realtime-monitoring` feature flag** |
| **Conversation WS** `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=…` (signed URL for private agents); JS/Python SDKs wrap it, WebRTC in the browser | **us** | `user_transcript`, `tentative_user_transcript`, `agent_response`, `agent_response_correction`, tool events | `contextual_update {text, context_id}`, `user_message`, `client_tool_result`, init-time overrides + dynamic variables | close the socket | any |

- **Monitor WS — verified.** elevenlabs.io/docs/eleven-agents/guides/realtime-monitoring:
  *"This is an enterprise-only feature."* *"The conversation must be active before
  you can connect to monitor it."* Enabled per agent via
  `conversation_config.conversation.monitoring_enabled` + `monitoring_events`
  (SDK `ConversationConfigInput`). The OpenTelemetry page: *"Real-time monitoring
  requires an Enterprise workspace or the `realtime-monitoring` feature flag."*
  **Tier measured 2026-09-23:** `GET /v1/user/subscription` → `tier: "starter"`.
  Whether the flag can be granted to a non-Enterprise workspace is **unknown** — O-33.
  Twilio calls are **believed** covered (it offers `transfer_to_number` and
  "remote control of active calls"); no page says "Twilio" outright.
- **Conversation WS — verified** from the AsyncAPI schema in `elevenlabs/packages`
  and the Python SDK (`Conversation`, `DefaultAudioInterface`, callbacks
  `callback_user_transcript`, `callback_agent_response`, …). `context_id`: *"only the
  most recent update with a given context_id is kept in the LLM context."*
  Accepts `ulaw_8000` in and out (SDK `asr_input_format`, `tts_output_format`), which
  is what a Twilio media stream carries — that is what makes our own bridge possible.
- **REST — verified** by listing every `/v1/convai/conversations*` route in
  `elevenlabs/cli` `reference.md` and SDK v2.68.0: delete, tags, files, feedback,
  analysis. Nothing live. D-79 already found there is no hang-up.

## What does not depend on any of this

**Consult (Phase R) works on the starter plan, on phone calls.** Consult is EL's
agent calling *our* server mid-call, not us watching it. It uses **webhook
tools** (or MCP-server tools) that run on EL's side, so it works whoever carries
the audio. Verified fields (SDK `webhook_tool_config_input.py`):
`response_timeout_secs` (*"between 5 and 300 seconds"*), `pre_tool_speech`
(`auto|force|off`), `tool_call_sound` + `tool_call_sound_behavior`,
`execution_mode` (*"'async' runs the tool in the background without blocking"*),
`assignments` (tool result → dynamic variables), `interruption_mode`. The
request can carry `system__conversation_id` and `system__call_sid` (*"twilio
calls only"*) so our server knows which call is asking. **Believed:** these fire
on phone calls exactly as on web calls — no page says "phone"; the first consult
call is the test. The *consult question* doubles as a live signal: every tool
call is an event we see in real time, with the conversation id.

**Hanging up (O-30) needs no EL feature — BUILT 2026-09-23.** EL's
outbound-call response returns the Twilio call SID (SDK
`TwilioOutboundCallResponse`; the wire name is **`callSid`**, camelCase, not
`call_sid` — the serializer renames only `conversation_id`), which the adapter
now keeps and the call service stores in `calls.phone_leg_sid`. With the
optional `agentPlatform.twilioHangup` block, `end_call` on a delegate call
hangs up through Twilio (PHASE-Q Implementation notes 2a); without it, it
still refuses. Twilio: *"To end a phone
call … pass a `completed` status to a `CallSid` in progress."* **Correction to
O-30 as written:** our existing *main-account API key* cannot do it —
twilio.com/docs/iam/api/subaccounts: *"Main account API Keys are only available
to access main account resources. Access to subaccount resources will be
denied."* A restricted API key **minted inside the subaccount** would, without
touching the credentials EL holds.

**The end-of-call record** stays authoritative whichever live path is used:
polling (built) or the signed **post-call webhook** `post_call_transcription`
(transcript + metadata + analysis; `ElevenLabs-Signature` HMAC). Every live
stream is best-effort; the post-call record is the one to store.

## Options for seeing a phone call live

| | Topology (audio hops) | Live view | Inject | Cost | Work | Touches |
|---|---|---|---|---|---|---|
| **A — today** | callee ↔ Twilio (subaccount) ↔ EL | none | no | — | done | — |
| **A+M — monitor** | as A; EL → monitor WS → `serve` | EL's own transcript | `contextual_update`, `end_call` | Enterprise or flag (O-33) | small: a WS client + two agent fields | INV-12 (key already held) |
| **A+T — Twilio transcription** | as A; Twilio STT → webhook → tunnel → `serve` | a **second, independent** STT of the same audio | no | ≈ US$0.027/min (2024 list; GA 2025-07-01, current price unverified) | small: persist `callSid`, subaccount key, one REST call | INV-10 (new route), INV-12, weakens D-73's isolation a little |
| **B — register-call** | callee ↔ Twilio (our webhook) ↔ EL; `<Start><Transcription>` before EL's TwiML | as A+T | no | as A+T | medium; EL documents *"No call transfers"* on this path | INV-7 at call setup only |
| **D — our bridge at the edge** | callee ↔ Twilio `<Connect><Stream>` ↔ **Cloudflare Worker/Durable Object** ↔ EL conversation WS | EL's own events, all of them | yes, everything | Workers + our time | high: we own the bridge, interruptions pass through | INV-7 kept only because the bridge is at the edge, not the laptop; new deploy surface |

A+T's weakness is real: a second speech-to-text will disagree with what EL's
agent actually heard, and Phase R needs the agent's view. D is the only route
that is live **and** plan-independent **and** carries EL's own view; it is also
the one that costs the most to build.

## Recommendations, per goal

1. **Consult (Phase R): build it now, on webhook tools.** Nothing above blocks
   it. Size `response_timeout_secs` from direct mode's measured think time;
   `pre_tool_speech: force` so the callee hears the agent stall rather than
   silence.
2. **Talk to an EL agent on the laptop: use the conversation WS via an SDK.**
   The Python SDK's `Conversation` + `DefaultAudioInterface` gives mic, speakers,
   live transcript callbacks and `contextual_update` on any plan, with no phone
   call and no PSTN cost. (A page on 127.0.0.1 using the browser SDK over WebRTC
   is the alternative.) It supersedes most of Phase P's hand-built audio plan for
   EL modes. It is **not** a phone-path test: WebRTC/PCM, not 8 kHz μ-law.
3. **The profile-preview session George asked for: run it on the laptop, on
   one agent with multi-voice.** Verified: *"Maximum of 10 supported voices per
   agent (including default)"*, switched with `<LABEL>text</LABEL>` markup, each
   voice with its own `speed`, `stability` and `similarity_boost`
   (`conversation_config.tts.supported_voices`). The agent speaks a sample in
   each labelled voice; George reacts; a webhook tool `save_profile{label, name,
   …}` writes the chosen settings back into our `profiles`. For "slower, deeper,
   more laid-back" tweaks, our server edits the voice entry and the next sample
   uses it — **unknown** whether a mid-session agent update takes effect before
   the session restarts, so plan for a quick reconnect. Agent **transfer** and
   **workflow nodes** can also change voice mid-call (verified) but are heavier.
   Running it on the laptop means we also see every turn live, for free.
4. **Hanging up delegate calls (O-30): Twilio REST with a subaccount-scoped key**,
   after persisting the call SID. George approved it 2026-09-23; built behind
   the optional `agentPlatform.twilioHangup` block.
5. **A live view of phone calls (O-32): decide the plan question first (O-33).**
   If the `realtime-monitoring` flag is available on our plan or cheaply, A+M is
   small and gives the right view. If not, and a live view becomes necessary
   before group meetings (O-29), build D. A+T is a stopgap that records a
   different transcript from the one the agent heard; do not build it by default.

## Traps this document exists to prevent

- **"Real-time API" means different things by who holds the audio.** Before
  assuming a live capability, ask: *does this call's audio pass through a socket
  we own?* If not, the only live surface is the Enterprise monitor.
- **`GET conversation` echoes `dynamic_variables: {}`** even when they were sent
  and used (D-83). Do not treat the echo as evidence.
- **Client tools do not work on native Twilio calls** — they execute in the
  client's code, and there is no client. Use webhook tools. (Believed from the
  docs' *"need to be registered in your code"*.)
- **A main-account Twilio API key cannot touch the subaccount.** Mint inside it.

## Unverified — settle before building on it

- Whether `realtime-monitoring` can be enabled on a non-Enterprise workspace.
- The monitor's received-event JSON shape (docs list types, not frames).
- Webhook tools and multi-voice **on a phone call** (no page says either way).
- ~~Whether an agent update applies to a session already in progress.~~
  **Measured 2026-09-23: it does not** (prompt and per-voice speed both
  ignored until reconnect) — see `VOICE-PREVIEW.md`, which is the built
  form of Recommendation 3 (hosted talk-to page, pull not webhook).
- Twilio real-time transcription's current price and region for this account.
