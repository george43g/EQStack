# Agent identity + a Twilio SMS layer — parked idea

**Status: PARKED, not scheduled.** Recorded 2026-09-05 at George's request
("save these ideas somewhere so we remember to circle back to them later")
while buying the second Twilio number for the telephony workstream. Nothing
here is committed to a phase; this exists so the shape is not lost.

## The thesis

> **"The next big customer for the next billion dollar business is no longer
> human — write tools that AIs would want, solve problems for AIs."**
> — George, 2026-09-05

That reframes the target user. The ideas below all follow from taking it
literally: an agent is not a script borrowing a human's accounts, it is a
long-running identity that needs its own.

## 1. Agents should own their identity, not borrow the human's

Today an agent that needs to message someone uses *George's* iMessage and
*George's* email. That couples every agent to one human's personal accounts and
makes it impossible to tell which agent did what.

Instead: **provision a unique phone number (and dedicated email) per agent.**

- Several agents — multiple openclaw agents, or long-running identities woken
  by n8n — each get their own SMS number and inbox.
- They stop depending on the human's personal SMS and email.
- They can **track a process start to finish**: the thread belongs to the agent,
  so the whole exchange is one continuous, attributable record.
- It unlocks work agents currently cannot do at all, because a reply has
  somewhere to land that is not a human's private inbox.

Twilio already supports programmatic number provisioning, so "one number per
agent" is an API call, not a manual step.

## 2. A Twilio SMS tool — probably NOT part of imsg-mcp

`imsg-mcp` is specifically **Apple's iMessage protocol**: it reads `chat.db` and
drives Messages.app. A Twilio SMS tool is a different substrate:

- It takes a **Twilio number + API key**.
- It **sends and receives** texts over Twilio.
- It must keep **its own database** of incoming and sent messages — there is no
  Apple database to read; the record only exists if we store it.

So this is likely a separate app (`apps/sms-mcp` or similar), not a feature
bolted onto imsg. The two remain distinct protocols with distinct storage.

## 3. Architecture: the inbox belongs in a published library

**A Twilio-number-based SMS inbox should be defined as a published library in
`packages/`**, written as a layer, not embedded in one frontend.

How that layer wires into a GUI is "not so obvious" — but this repo has solved
exactly this shape before (core owns behaviour, frontends only render; see the
media-intel rule in the imsg guide), so the pattern is proven here rather than
speculative.

Making it a library is what enables the payoff below.

## 4. The payoff: one consolidated conversation per contact

With the inbox as a shared layer, `imsg`'s CLI / TUI / MCP can all extend to
show a **unified interface**:

- Contacts listed with **names above their numbers**.
- The user chooses to send from **either his iMessage number or his Twilio
  number**.
- **Whichever number an SMS arrives on, it appears in one consolidated view
  under the same contact.**
- **Outgoing messages are reflected accurately regardless of which service sent
  them** — no gaps, no duplicates, no "sent" state that lies.

This is the same identity-merge problem imsg already solves across phone/email
and SMS/iMessage legs (`docs/CONTACT_MERGE_AND_SLUGS.md` in the imsg app) —
extended with a new transport. The existing merge invariants are the natural
starting point, and the reason not to invent a second identity model.

## Addendum 2026-09-24 — an agent-owned SMS number, on an existing chat stack

George, answering which number delegate calls should come from (verbatim):

> *"be aware that there's already a mobile number in the account... or there should be... because twilio has also been used to send sms messages. i eventually want to add capability, somewhere somehow (not sure if in this tool or a separate tool) where a twilio mobile number will be able to attach to a CLI tool and that mobile number can literally almost belong  to an AI agent... ie I'll be able to open a TUI that will show a history of all sent and recieved sms messages from that mobile number like any other phone sms app. but will have a cli and mcp API that agents can drive as well as humans. rather than rebuilding an entire chat infra, its worth looking at services like snikket or cheogram that allow you to BYO number from twiliio and attach it to an xmpp or IRC client, so all your message thread functionality is pre built out of the box - so unlikely its something we want to build from scratch, but if we can utilise  an existing solution, and just bolt on the needed APIs, ie twilio, MCP, CLI, TUI and AI agents and skills etc..."*

What this adds to §2–§3:

- **The number exists.** Twilio's master account holds `+61 4…1463`, type
  **mobile**, SMS + MMS + voice enabled (measured 2026-09-23 via the Twilio MCP).
  Its `sms_url` is still Twilio's demo reply, so nothing receives its SMS today.
  That is the natural first "agent-owned" number.
- **Don't build the chat layer.** The direction is an existing SMS↔chat bridge
  that accepts a bring-your-own Twilio number — George named **Snikket** (an XMPP
  server) and **Cheogram** (the XMPP↔SMS gateway behind JMP.chat) — so threads,
  history, read state and multi-device come for free from an XMPP (or IRC)
  client, and we bolt on only what is missing: the Twilio wiring, an MCP server
  and CLI agents drive, a TUI for George, and skills. Which bridge, and whether
  it accepts a Twilio number without a JMP subscription, is **unverified** —
  the check-for-existing-solutions pass is the first step, before any code.
- **Home undecided** — "not sure if in this tool or a separate tool". §2 already
  argued it is probably not imsg-mcp; this keeps that open.

## When to circle back

No date set. Natural triggers: after the telephony Q/R phases land (agent
identity and agent-owned numbers are the same theme), or whenever a concrete
agent needs to receive a reply that must not go to George's personal inbox.

Before building any of it, check for an existing solution first — that rule
applies here as everywhere.
