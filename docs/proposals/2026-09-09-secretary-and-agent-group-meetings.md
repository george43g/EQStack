# The secretary, and live group meetings with agents — parked vision

**Status: PARKED, not scheduled. Do not act on this.** Recorded 2026-09-09 at
George's request: *"dont act on this narrative now — just save it somewhere so we
can read it and be aware of the direction we're driving progress towards."*

> **The secretary already has a home — do not build a second one.** George decided
> 2026-09-15 that the phone-answering secretary in this document and the team
> secretary in the `executive` repo are **one role**. Recorded there as D14, verbatim:
> *"the EQStack phone persona and this secretary are one role"* — in
> `~/repos/executive/docs/registers/decisions.md` (commit `5248a4c`). Her home is
> `~/repos/executive/team/secretary/` (`AGENTS.md`, `policy.toml`). When this work
> unparks, the phone work lands **on her**, not on a second persona built here.
> Relayed by the `executive` session 2026-09-15, and checked against that commit
> before being written down.
>
> **She does NOT get the Twilio MCP.** Decided the same day, in her own register:
> *"Twilio is the executive's, not the secretary's"* — George: *"twilio access is
> more appropriate for the executive - the secretary is kinda like a gate to the
> outside world or a firewall for spam, prompt injection or other malicious
> requests"* (`~/repos/executive/team/secretary/docs/DECISIONS.md:210-214`, commit
> `1f6036a`). So hooking the phone up to her must not be done by giving her the
> `twilio` server: she is the filter in front of outside traffic.

This is a **destination document**. It exists so that when the pieces below get
built, they get built pointing at the same place. Read it before designing the
secretary, before Phases L–M (inbound), and before any multi-party call work.

---

## The narrative, in George's own framing

He calls his own Twilio number. **The secretary picks up.**

> "Hey — call an all-company live group meeting now."

Every agent joins the group call. Everyone can speak and hear each other. In that
meeting he can poll them, ask for advice, gather different perspectives, discuss
something, organise or drive or direct an effort, spread a message to all of them
quickly, or take feedback and delegate tasks — **like any ordinary real-life
meeting.**

The secretary is the one who makes sure everyone picks up, and the one who makes
sure everyone hangs up. She ends the group call — and is still on the line:

> "Can I help you with anything else today, Boss Human?"

> "Yeah — call another group meeting, but only with the top-level executives from
> my X company and my Y company."

(Both are AI agents, each with a different ElevenLabs voice.) Then the part he
flags as the cooler bit — **and all of this is happening over an ordinary mobile
phone call**:

> "Add my real human mate X, and my real human business contact Y to the call."

The secretary reads its context, checks the **humans files**, and understands who
these people are to him — *because humans files store nicknames too, which is how
it resolved them from nothing but a nickname*. With the friend's full name it can
search and read the notes, memories, emails, iMessages and more tied to that
person, giving it deep understanding. Finally it does a **contacts lookup** for the
real number, calls X, and **explains, prepares and briefs him**: why an AI is
calling, who is behind it (his friend George), and that the purpose is to connect
everyone to a business meeting that will be held on a group call with two AI agents
also on the line.

Afterwards, all transcripts are saved **and summarised**.

---

## The specific design notes he attached

- **Voices are an interface, not decoration.** ElevenLabs allows different voices
  and cadence. Agents *"should always speak reasonably quickly to save precious
  time and money"* — but **differing voices are what make speakers distinguishable**
  on a call with several agents on the line. Voice assignment is therefore a
  first-class part of multi-party design, not a per-agent nicety.
- **Secretary ≠ coordinator.** *"Coordinator and secretary would have similar but
  not identical roles — the word definitions have nuanced differences."* Do not
  collapse them into one component without deciding which is which.
- **The secretary gates as well as coordinates** — *"to stop spam or loops"*. That
  gating role is why she sits in front of everything, and it is the same argument
  he made on the bus for a guard agent as a filter and load balancer.
- **Enabled in part by the telephony tool** — but possibly needing *"something more
  sophisticated or targeted, like an agent meeting tool, or a generalised
  coordination stack and agent that takes care of ntfy, comms, shared knowledge
  streams and group calls and group voice meetings."* The scope is deliberately
  wider than telephony.
- **Not necessarily a phone call.** *"Could be any meeting app too, like Zoom…
  maybe one day I'll be able to wire up video feeds / streaming — either the
  console, or a visual they want to see."*
- **Transcripts + summaries:** *"we may decide to just use Fireflies' note-taking
  and call-recording feature for this"* — an option to evaluate, not a decision.

---

## Why this is filed here rather than as a phase

It crosses four workstreams that today do not know about each other, and no single
phase file owns it:

| Piece | Where it lives now |
|---|---|
| Inbound call → an agent answers | telephony **Phases L–M**, not built |
| Multiple agents on one call, distinct voices | beyond Phase Q/R — Q is *one* delegate agent on a call |
| Secretary as gate + coordinator | live fleet discussion on the `ag-all` bus (2026-09-09) |
| Nickname → person → notes/emails/iMessages → real number | imsg-mcp **humans files** + contacts layer |

## What it changes about work already in flight

Recorded because these are cheap to preserve now and expensive to retrofit:

1. **Inbound (L–M) has a named first customer.** The secretary answering
   `+61…1463` *is* the inbound use case. Design L–M so the answering agent is
   pluggable rather than hardcoding one behaviour.
2. **Voice identity needs to be per-agent, not per-profile.** Today `voice` is one
   block in config with a single `voiceId`. A meeting needs a stable voice **per
   participating agent**, and stability matters — a voice that changes between
   meetings destroys the recognisability that is the whole point.
3. **Group calls are not N one-to-one calls.** Twilio Conference / ElevenLabs
   multi-party is a genuinely different call shape from anything in Pass 1, which
   is one-callee throughout. Nothing built so far assumes multi-party, and nothing
   should be *allowed* to assume single-party permanently.
4. **Briefing a human before an AI speaks to them is a consent surface.** The
   secretary calling George's friend and explaining who is behind the call is the
   right instinct and should be treated as a requirement, not a courtesy — it is
   the same family as the existing `play_disclosure` / consent invariants.
5. **The humans-file nickname path is load-bearing here**, which raises the value
   of nicknames being reliably present. That is an imsg-mcp concern today.

## Addendum 2026-09-23 — group-call social skills, open invitations, and voices

George, after the voice audition (verbatim):

> *"the other voice profiles can still be used in situations where there's a group call with multiple agents (we'll need a harness for group calls to explain to agents how to behave in a group call so they dont each always respond to every single message and constantly interrupt eachother, they will need "group call social skills to make them possible, especially if there are one or more human members in the group - but i did like the link - it should be possilbe to invite external humans and external ai agents to our group calls via a simple link or mcp or api so that outsiders can join in our process without having been designed for it in future"*

Three requirements this adds, each cheap to honour now and expensive to retrofit:

1. **A group-call harness ("social skills").** Every agent on a group call gets a
   preamble on top of O-24's harness: do not answer every utterance; speak when
   addressed, when you hold information nobody else has, or when the chair asks;
   never talk over a speaker, and yield to humans before agents; keep turns short;
   defer to a named chair (the secretary). It is a *prompt contract plus a turn
   arbiter*, not only a prompt: something must decide who may speak next, or N
   polite agents still collide. It is the group analogue of O-24/O-25 and belongs
   beside them.
2. **Open invitations.** An outsider — a human or someone else's AI agent — must be
   able to join by **a link, an MCP tool, or an API call**, with no prior
   integration. The voice audition proved the link half already exists on
   ElevenLabs (a hosted talk-to page per agent); the MCP and API halves are ours
   to expose. Invitation is also a consent and access surface: who may mint a
   link, how long it lives, and what the joiner is told before anyone speaks
   (O-29(d)).
3. **Voices map to agents.** The profiles auditioned 2026-09-23 but not chosen as
   George's own are the pool for *other* agents' voices in a group call — the
   per-agent stable voice identity of O-29(b). Saved so far: `lily`, `archer`
   (George's picks); the remaining candidates live in `PREVIEW_CANDIDATES`
   (`apps/telephony-mcp/src/domain/voice-preview.ts`).

And a standing principle George stated the same day, which governs how all of this
gets built:

> *"agents should be able to easily set stuff like that up using the mcp tools and apis with none or minimal custom code or scripts in an ideal world"*

So prefer configuring the platform (EL agents, tools, MCP-server registration,
hosted links) through its MCP tools and APIs over bespoke code; write code only for
what the platform cannot do, and say why in the commit.

## When to circle back

No date. Natural triggers: when the fleet decides the **secretary** is being built
(the bus discussion is live now); when **Phases L–M** are scheduled; or the first
time someone wants two agents on one call. Before building any of it, check for an
existing solution — group calling, conferencing and meeting transcription are all
mature markets, and the standing rule applies here as everywhere.
