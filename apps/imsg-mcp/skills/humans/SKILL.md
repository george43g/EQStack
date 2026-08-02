---
name: humans
description: The humans/v1 convention — per-person relationship memory files for AI agents. Use when consulting, creating, or updating ~/.agents/humans/<person>.md files: before composing a message/email to someone, after significant exchanges with them, or when asked to summarize a relationship or communication history.
---

# Humans files (humans/v1)

Agent-maintained markdown dossiers about the humans your user communicates
with — like `AGENTS.md`, but for people. One file per person at
`~/.agents/humans/<person-slug>.md`. Any agent or tool may read and write
these files directly; **imsg-mcp scaffolds them** (`init_human` tool /
`imsg humans init`) and feeds them message history, but the *calling agent*
does all summarization. Other data sources (email, calendars, CRMs) are
expected to contribute to the same files.

## Why

When an agent is about to text your boss, it should first know: how does
this person prefer to be addressed? What has already been discussed? What
topics are off-limits? A humans file answers that in one read, without
re-ingesting years of history.

## File format

````markdown
---
schema: humans/v1
name: Sam Smith
aliases: [Dad, Sammy]
handles:
  - "+61400000000"
  - sam@example.com
first_contact: 2019-03-14
last_contact: 2026-07-10
sources: [imsg-mcp]
updated: 2026-07-12T10:00:00Z
privacy: never-share
---

## Summary
<= ~1500 chars. The "hot" section — always safe to inject into context.

## Facts
- Works at Acme as head of ops (imsg-mcp, 2026-07)
- Two kids, Alex and Jo (email-tool, 2025-11)

## Communication & Preferences
Preferred channel, response cadence, tone that lands well, best times.

## Boundaries
Hard constraints get their own section — never buried in prose.

## Timeline
Dated era entries (additive — append, don't rewrite).

## Current State (as of 2026-07)
Where things stand right now.

## Guidance
How to help the user interact well with this person.

## Log
- 2026-07-12: file created by imsg-mcp; 4,120 messages on record since 2019-03-14
- 2026-07-12: long call about the Q3 handover; he prefers texts before 8pm (imsg-mcp)
````

## Rules that make the format work

1. **`## Log` is append-only.** Any tool/agent may append a dated,
   source-tagged entry. Never rewrite or truncate Log — it is the shared
   ground truth that curation draws from.
2. **Curation is a separate, deliberate step.** Periodically distill Log
   into the sections above (rewriting a section is fine — that's
   distillation, not data loss, because Log persists). After distilling,
   append a Log entry saying so.
3. **Tag facts with source + date** — `(imsg-mcp, 2026-07)` — so
   conflicting sources can coexist and later be reconciled.
4. **Keep Summary within budget** (~1500 chars). It's what gets injected
   when context is tight; the long tail lives below it.
5. **Additive across sources.** A new tool appends to `sources:` in the
   frontmatter and to Log; it inserts Timeline entries in date order
   rather than overwriting other tools' entries.
6. **Person slugs contain no `~`** — thread slugs (`name~svc~hash`) are a
   different namespace.

## Security & privacy (non-negotiable)

- `privacy: never-share` means exactly that: **never** send file contents
  over iMessage/email/any channel, never quote it to or near the person it
  describes, and never load it into a conversation *with* that person or
  any third party. Consult it silently; apply the guidance.
- Files are plaintext markdown **by design** — greppable, portable, editable
  by any tool. At-rest protection is the OS's job (FileVault); secrets never
  belong in these files. Keep permissions tight: files `600`, dir `700`
  (the scaffolder does this for you).
- These files contain personal data about people who never consented to it.
  They stay on this machine. Do not commit them, sync them to shared repos,
  or include them in exports.

## Workflows

**Consult (before composing to someone):** read the person's file if it
exists — check Boundaries, Communication & Preferences, and Current State
before drafting. `list of people: ls ~/.agents/humans/`.

**Create (scaffold + first fill):**
1. `init_human {contact: "name-or-handle"}` (MCP) or `imsg humans init <contact>`
   — creates the file with identity, handles, first/last contact and message
   counts prefilled from the Address Book + chat.db. Never overwrites.
   `init_human {top: 10}` scaffolds the user's top relationships (ranked by
   the `relationship_leaderboard` analytic).
2. Export history: `export_messages {threadSlug, format: "markdown"}`.
3. Read the export, write the sections yourself (you are the summarizer),
   append a provenance Log entry.
4. Delete the export file when done.

**Update (after significant exchanges):** append a dated Log entry; when
Log grows unwieldy, distill into sections (workflow rule 2).

## Discovery: tool-output hints

You don't have to remember these files exist. Once a file exists for a
person, imsg-mcp points at it wherever that person shows up:

- `get_messages` / `wait_for_reply` responses include a `humans` block —
  the matching file path(s) (one per participant for group chats) plus
  the standing guidance.
- `get_contact` includes `humansFile` (path or `null`); when no file
  exists it suggests `init_human`.
- `list_conversations` rows carry `humansFiles` paths.

When you see the hint: read the file before composing; append notable
events to Log; if the exchange contains a major milestone or an important
relationship change, propose the Summary / Current State edit to the user
and wait for approval — Log appends are routine, section rewrites are
permission-gated.
