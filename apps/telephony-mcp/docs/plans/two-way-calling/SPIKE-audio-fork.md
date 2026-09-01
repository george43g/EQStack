# SPIKE S — does a media fork compose with ConversationRelay?

**Read order:** [`WORKSTREAM.md`](./WORKSTREAM.md) → [`DECISIONS.md`](./DECISIONS.md) →
this file → code.

## Inherited invariants

- **INV-14** — the default suite makes no paid calls. This spike *needs* one, so it
  is gated on George's authorisation at the time, not assumed. See §Cost.
- **INV-10** — any new publicly-reachable route (the fork's WSS endpoint) is
  signature-validated and, if it ever ships, needs a `DECISIONS.md` entry.
- **INV-11** — nothing captured in this spike is persisted. Throwaway branch,
  throwaway sink, no recordings on disk.

## The question

> Does `<Start><Stream url="wss://…"/></Start>` — a non-blocking media fork —
> compose with `<Connect><ConversationRelay …/></Connect>` **in the same TwiML
> document**, such that the fork delivers audio while ConversationRelay runs the
> conversation normally?

Yes / no. Nothing else. This spike does not build listen-in, does not decode audio,
does not ship.

## Why it matters

**ConversationRelay is a text protocol and the gateway never sees audio bytes at
all.** Not "we don't currently read them" — there is no audio frame in the contract:

- Inbound union is `setup` | `prompt` | `interrupt` | `dtmf` | `error`
  (`src/adapters/telephony/relay-messages.ts:47-53`); the speech arrives as
  `voicePrompt: z.string()` (`:16-23`), already transcribed by Twilio.
- Outbound builders are `textFrame` and `endFrame` only
  (`src/adapters/telephony/relay-messages.ts:83-91`).

So **live audio listen-in is impossible today by construction**, and D-13 ("live
listen-in staged: text now, real audio as an isolated spike") is what that
constraint forces.

The only two routes to real audio are:

1. **A media fork** alongside ConversationRelay — this spike.
2. **Abandon ConversationRelay for raw bidirectional Media Streams**, which means
   implementing STT, TTS, barge-in and turn-taking ourselves. The original plan
   explicitly forbids that without evidence: *"Raw bidirectional Media Streams stay
   a measured escape hatch only (8 kHz μ-law, codec/turn-taking work) — do not
   switch without latency evidence"* (`../2026-08-02-voice-mcp.md:25-28`).

The spike exists so that (2) is never chosen by accident.

## The hypothesis — and why it is UNVERIFIED

**Hypothesis.** `<Start>` verbs are documented as non-blocking (they start a
background action and fall through to the next verb) while `<Connect>` blocks for
the life of the connection. If that holds inside one document, a `<Start><Stream>`
placed *before* `<Connect><ConversationRelay>` should fork the media to our WSS sink
and then hand the call to ConversationRelay unchanged.

**This is a hypothesis about Twilio's behaviour, not a known fact.** Nobody in this
workstream has run it. Specifically unverified:

- whether Twilio accepts the two verbs in one document at all, or rejects it as
  malformed / silently drops one;
- whether a fork survives `<Connect>` taking over the call;
- what the fork actually carries once ConversationRelay owns the media —
  caller-only, both legs, or ConversationRelay's synthesised TTS as well;
- the frame format and codec on the fork socket — *unknown, verify against the
  Twilio Media Streams docs before writing any decoder.*

Do not write any of the above into a plan as established. If the spike is skipped,
the honest downstream statement is "unknown".

**Fallback if in-document composition fails:** Twilio may expose a REST resource for
starting a media stream on an already-connected call — *unknown, verify against the
Twilio Voice API reference.* If it exists, the same yes/no question is re-asked in
that form before the spike is declared dead.

## The minimal test

Throwaway branch, never merged. The whole change is local because **TwiML is built
inline and passed as the REST `Twiml` parameter** (`src/adapters/telephony/twilio-conversation-relay.ts:112`)
— no webhook, no TwiML Bin, no Twilio console change.

1. Stand up a throwaway WSS sink (a dozen lines of `ws`) behind the existing tunnel.
   It logs frame count, first frame verbatim, and bytes/second. It writes no files.
2. On the branch, edit `buildConversationRelayTwiml`
   (`src/adapters/telephony/twilio-conversation-relay.ts:48-64`, returns the document
   at `:63`) to emit:
   `<Response><Start><Stream url="wss://…/spike"/></Start><Connect><ConversationRelay …/></Connect></Response>`
3. Place **one** call to George's own number. Speak for ~20 seconds, both directions.
4. Record four observations: (a) did the call connect normally; (b) did
   ConversationRelay behave identically (prompt frames, barge-in); (c) did the sink
   receive frames; (d) what is in them.
5. Write the answer — including the codec/direction facts — into `DECISIONS.md` as a
   Settled row anchored to the call SID and the sink log. Delete the branch.

**Time box: one working session, one call.** If the sink is not receiving frames
within that session, the answer is "no, not this way" and the spike ends.

## Cost and authorisation

One outbound PSTN call of roughly a minute — cents. The cost that matters is not
money, it is **INV-14**: paid live calls are authorised by George at the time.
Do not place the call on the strength of this document alone.

Also note **O-8** — the Twilio `SK…` rotation is still pending and this spike uses
those credentials. Confirm the key is current before dialing.

## Kill criterion

Stop and write "no" if **any** of these is observed:

- Twilio rejects the document (a 21xxx error on create-call), or the call fails to
  connect;
- ConversationRelay behaviour changes at all — dropped prompt frames, broken
  barge-in, altered TTS. **A fork that degrades the conversation is a failure even
  if audio arrives.** Mode 1 is the product; listen-in is a view onto it;
- no frames reach the sink within the call;
- the session budget is spent.

There is no "try a third variation" clause. One session, one call, one answer.

## What the result means downstream

**Positive.** Real-audio listen-in has a route that keeps ConversationRelay, so
Phase P (local audio) can plan a real listen-in path and the "raw Media Streams"
escape hatch stays shut. Record the codec and which legs are present — those two
facts size the decoder work.

**Negative.** Listen-in stays **text-only for the foreseeable future**, and every
later phase must plan on that: Phase G's console, Phase I's TUI, Phase J's SPA and
Phase P all render the transcript, not audio. Anyone proposing real listen-in after
a negative result is proposing the raw-Media-Streams rewrite, and owes the latency
evidence `../2026-08-02-voice-mcp.md:25-28` demands.

**A caveat worth stating even on success:** a fork gives raw audio frames, not
playable audio. Decoding 8 kHz μ-law, buffering, and device output is the *same
plumbing* the raw-Media-Streams route requires — the fork only saves us STT, TTS and
barge-in. So "positive" means "the cheap route exists", not "listen-in is nearly
done". Size Phase P accordingly.

## Seam left behind

A single Settled row in `DECISIONS.md`: **does `<Start><Stream>` compose with
`<Connect><ConversationRelay>` — yes or no**, anchored to a call SID, plus (if yes)
the codec and which call legs the fork carries. That row is the entire deliverable.
No code survives this spike.
