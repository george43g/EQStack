# WORKSTREAM — two-way agent calling (`telephony-mcp`)

> **This file outranks any individual phase file.** Where a phase plan and this
> document disagree, this document is correct and the phase plan is stale.

**Read order for every agent picking up a phase:**
1. This file (invariants + seam map)
2. [`DECISIONS.md`](./DECISIONS.md) (what is Settled / Open / Rejected)
3. Your own `PHASE-*.md`
4. Only then, code.

Background (read once, not per phase):
[`../2026-08-24-two-way-voice-brief.md`](../2026-08-24-two-way-voice-brief.md).

---

## Mission

Turn a proven prototype into a tool George uses daily: he asks an agent to call
him, and they talk. The two-way path already works — `mode: "direct"` carried a
3.5-minute live conversation on 2026-08-02 with no intermediary LLM. What's missing
is everything around it: a tunnel that stops churning, lag that doesn't read as a
dropped line, calls to numbers that aren't pre-registered, inbound calls that reach
an agent, and one honest API behind every frontend.

**This is productionisation, not a greenfield build.** Treat existing code as
proven-until-shown-otherwise. Prefer extending a seam over replacing a subsystem.

---

## Constraints — George, verbatim

Quoted, not paraphrased, so nobody has to re-derive intent. All 2026-08-29 unless
noted. Reference these instead of restating them.

**On changing things** — this is the licence that makes the rewrite phases legitimate:
> *"there are no existing consumers of this package in any production use - now is the
> time to change or rewrite anything to get it perfect, esp stuff that will be hard to
> change later."*

**On deletion** — a hard gate, not a courtesy:
> *"make sure we dont lose any useful features... if we are, ask me about the feature
> we are losing and discuss with me first before deleting."*

**On kit adoption** (why the TODO ledger exists, and why it is not worked during Phase A):
> *"its okay if we lose some customisation as long as any lost features are noted in a
> TODO and re-implemented before the end of this workstream - id just rather that any
> features that need to be re implemented get implemented not in the same phase as the
> adoption, but in the same phase as when that feature is relevant to the current phase
> being worked on - this prevents pointless refactoring in case a certain feature ends
> up being deprecated or otherwise unused by the end of the workstream."*

**On phase granularity and why this file exists:**
> *"the more you split it up into small phases, is generally better - however! big
> caveat - there needs to be a high level abstract continuity and consistency and memory
> between phases - you cannot allow the same system to be designed twice in two
> completley different ways because "phase X" forgot or had no knowledge of what "phase
> Y" did."*

**On what "good design" means here** — redesign is allowed; *needing* it is the failure:
> *"i want to prevent the need for a later phase to redo an earlier phases work by
> ensuring that when the phases were designed, there was enough planning and forward
> thinking and good design that this will simply not be required - for instance, an
> earlier phase might build something or leave a seam for a later phase to come fill in
> - the phases should be collaborative and know about eachother, rather than conflicting
> with eachother."*

**On architectural questions** — do not guess and do not default:
> *"if there are any questions or decision about code structre or other software
> architectual questions, use the ability to ask me a question to "grill" me about
> everything until a clear picture based on my preferences is formed about how this
> should all be coded and implemented."*

**On routing** (the standing check behind INV-7):
> *"if optimisations around infra routing like this are possible, check them on every
> tool type and call."*

**Project-general, not workstream-specific** — applies to any implementation plan in
this repo, and should outlive this workstream:
> *"when writing implementation plans for this project, create a folder just for this
> workstream, and have a separate file (the agent will compact context in between phases
> where the it moves onto the next planning file) for each group of PRs so for each
> phase."*

---

## Invariants

Numbered so phase files can cite them. **No phase may silently contradict one.**
To break one, see [Changing an invariant](#changing-an-invariant).

> ⚠️ **Staleness is this document's failure mode.** A file that asserts precedence
> and is out of date authoritatively tells a fresh agent something false — worse than
> having no file. Two rules follow, and they are not optional:
> 1. Every invariant carries the date it was last true (`[YYYY-MM-DD]`).
> 2. **A change to an invariant lands in the SAME PR as the code that changed it.**
>    Never in a follow-up, never "documented later."
>
> All invariants below: `[2026-08-29]` unless individually restamped.

### Product

- **INV-1 — No tool-name prefix.** Hosts already namespace MCP tools
  (`mcp__telephony-mcp__call`). Every tool name must be self-describing *without* a
  prefix: `say_on_call`, not `say`; `listen_for_calls`, not `listen`.
- **INV-2 — Dialing is not gated.** Any valid E.164 number may be called. Aliases in
  config are nicknames and defaults, never permissions. *"If a human asks you to call
  a number, that means you're allowed to call it, end of story."* — George, 2026-08-24.
- **INV-3 — Recording is a separate axis from dialing.** `consent.ts` governs
  recording only and its three policies stay load-bearing: `never` is unrecordable,
  `manual` starts unrecorded, `preconsented` records by default. Ad-hoc numbers get
  `manual` — they connect instantly and simply don't record.
- **INV-4 — Direct mode has no LLM mediating speech.** Whatever the host sends to
  `say_on_call` is spoken verbatim to a real person. Widening *who* can be reached
  does not add a filter; it is a deliberate property, not an oversight.

### Architecture

- **INV-5 — One definition per operation.** The command registry is the single
  source of truth. MCP-stdio, MCP-HTTP, REST, WS, CLI and console are **thin
  adapters** that look up, validate, dispatch. If an operation is defined in two
  places, that is a bug regardless of whether the two agree today.
- **INV-6 — Parse, don't guess.** Zod at every boundary. `String(body.x ?? "")` is
  forbidden — it turns a missing field into a silently malformed command. The repo
  already states this rule at `src/config/schema.ts:2`; the admin boundary currently
  violates it, and Phase B fixes that.
- **INV-7 — The orchestrator sits at the end of the chain, never in the media path.**
  Before building any call path, draw its hop diagram and delete every hop that
  exists only because the laptop was in the way.
  - ✅ `laptop (commands) → OpenRouter → ElevenLabs → Twilio`
  - ❌ `OpenRouter → laptop → ElevenLabs → cloudflare → laptop → Twilio`
- **INV-8 — Surface parity is structural, not a discipline.** Console `help` and SDK
  types are *generated from* the registry. Anything hand-maintained per surface will
  drift and is therefore wrong by construction.
- **INV-9 — Single WAL writer.** The serve process owns the sqlite DB. Everything
  else mutates through the loopback API and reads via read-only connections.

### Safety and privacy

- **INV-10 — Public surface stays minimal and signature-validated.** Every route
  reachable through the tunnel validates `X-Twilio-Signature` against the public URL.
  Admin, metrics and event streams bind `127.0.0.1` only and are never routed through
  the tunnel. Adding a public route requires a `DECISIONS.md` entry.
- **INV-11 — Full phone numbers exist only in config.** Everything persisted or
  emitted — events, logs, MCP output, FTS, SDK payloads — carries alias + last four.
  All logging goes through `logger`; never bypass it. Never log or store secret
  values, tunnel URLs, or recording plaintext.
- **INV-12 — Secrets resolve by NAME** via env → opkeep keychain. No `.env` files, no
  literal secrets in config, code, tests or fixtures.
- **INV-13 — Recordings stay AES-256-GCM encrypted at rest.** Audio bytes never cross
  MCP. Deletion requires scope + explicit confirmation.

### Process

- **INV-14 — The default test suite makes no network calls and no paid calls.**
  `tests/helpers.ts` provides the fakes. Live/paid verification is separately
  authorised by George at the time, never assumed.
- **INV-15 — `private: true` stays through Pass 1.** In this msr monorepo that flag
  is the release switch. Before it is ever flipped, push a baseline tag first — the
  1.0.0-downgrade trap that nearly shipped imsg wrong and was defused for gmail.
- **INV-16 — One merge at a time.** Each merge to `main` triggers a Release run;
  back-to-back merges silently strand a release. Merge, wait for the run, then merge
  the next.
- **INV-17 — Never `git add -A`.** `docs/research/*` and `docs/agent-handoff/*` are
  deliberately untracked. Commit path-scoped, naming the files you touched.

---

## Seam map — what each phase leaves for the next

The point of this table is that **no phase should ever need to redo an earlier
phase's work.** If you find yourself wanting to, stop and read
[Changing an invariant](#changing-an-invariant).

| Phase | Leaves behind (the seam) | Consumed by |
|---|---|---|
| **A** rename + kits | Kit dependencies wired; TODO ledger of customisations deliberately dropped | every later phase |
| **B** command registry | The registry + shared contracts. **`CallMode` must be an open union sized for 4 modes + the consult loop**, not today's `"llm" \| "direct"`. **B stays provably behaviour-neutral** — it does the INV-1 rename and keeps `prepare_call` + `start_call` as two registry entries; it does NOT merge them | C, D, G, H, and every later mode |
| **C** open dialing | **Both** dial gates deleted; `prepare`+`start` merged into one-shot `place_call` with `dryRun` + idempotency; ad-hoc recipient synthesis | Q, R, T (all modes dial through it) |
| **D** tunnel + daemon | Stable public hostname; supervised process lifecycle | H (MCP-HTTP needs a stable URL), R (ElevenLabs calls our https MCP endpoint) |
| **E** instrumentation | Real per-turn latency numbers for direct mode | F (how long to mask), R (`response_timeout_secs` must match reality) |
| **F** thinking sound | `playFrame` builder + the thinking-state lifecycle | K (mode handoff reuses the state machine) |
| **G** console view | Event-stream parsing + rendering primitives | I (TUI), J (web SPA) |
| **S** audio spike | A verified yes/no on `<Start><Stream>` + `<Connect>` composition | P (local audio), listen-in |

**Why B is behaviour-neutral and C does the merge** `[2026-08-29]`. B is the most
consequential phase, so it needs the strongest verification story: *"every existing
operation behaves identically, only its definition moved."* Folding D-5's
`prepare`+`start` merge into B would destroy that — B would ship a behaviour change
wearing a refactor's clothes. The rename costs one extra step in C and buys a
provable B.

⚠️ **Long-poll vs idle watchdog** `[2026-08-29]`. `@george43g/mcp-kit`'s `startStdio`
wires the robustness idle watchdog, but `noteActivity()` fires from the *dispatcher*.
A direct-mode host parked in a 55-second `get_call_events` long-poll
(`src/mcp/server.ts:323-329`) therefore looks **idle** — and the watchdog could kill
the MCP process mid-call. Any phase adopting `startStdio` must prove the long-poll
path keeps the watchdog fed. This is why Phase A's kit adoption is necessarily
partial (leaf helpers only) and the dispatcher/transports land in B.

**Load-bearing seam, stated twice on purpose:** Phase B's `CallMode` is the single
most consequential type in this workstream. Four conversation modes exist in the
plan (Appendix A of the approved plan) and only two exist in code. Phase B must
leave that union open, or Phases Q/R/T will each be tempted to redesign it.

---

## Phase graph

```
Pass 1
  A ─▶ B ─┬─▶ C   open dialing
          ├─▶ D   tunnel + daemon        } C, D, E parallel after B
          └─▶ E   instrumentation ─▶ F   thinking sound ─▶ G  console view

  S  audio-fork spike ......... independent, parallel with everything

Later (LATER-phases.md)
  H daemon MCP-HTTP + WS + SDK ─┬─▶ I  TUI
                                └─▶ J  web SPA
  K mid-call mode handoff ─▶ L–M inbound ─▶ N Cloudflare Worker
  P local audio (pull early — removes a paid call from every test cycle)
  Q mode 2 · R mode 3 · T mode 4 · U skills · V hint channel
```

**Parallelism rules.**
- Plan files: fully parallel (no code, no conflicts).
- Build: A and B are strictly sequential and block everything.
- After B: C, D, E may run concurrently — they touch disjoint files.
- **E before F, never parallel** — both edit `src/gateway/session.ts`.
- S is isolated (throwaway branch) and may run at any time.
- Regardless of build concurrency, **merges serialise** (INV-16).

---

## Conventions

- **Naming:** package `telephony-mcp`, bin `tel`, app dir `apps/telephony-mcp`.
  Tools per INV-1.
- **Phase files** open with `## Inherited invariants` citing the INV-numbers they
  depend on, then `## Scope`, `## Non-goals`, `## Steps`, `## Verification`,
  `## Seam left behind`.
- **TODO ledger:** customisation dropped during kit adoption is recorded in
  `PHASE-A-rename-and-kits.md` and re-implemented **in the phase where that feature
  is relevant** — never during adoption. Rationale: a feature that turns out to be
  deprecated by the end of the workstream should never be re-implemented at all.
- **Verification per phase:** `pnpm --filter telephony-mcp test typecheck lint` →
  root `pnpm verify` → PR → CI → merge → wait for Release run.

---

## Changing an invariant

Redesign **is allowed** when the existing design has a real flaw. George's
requirement is not that nothing changes — it is that phases are *forward-looking and
collaborative*, so rework is not needed for foreseeable reasons.

To change an invariant or an earlier phase's design:

1. Add a row to `DECISIONS.md` under `## Settled`, with the reason and an anchor.
2. Move the superseded decision to `## Rejected` with why it was wrong — never
   delete it, or the next agent re-proposes it.
3. Update this file's invariant in place and note the date.
4. Flag it to George if it changes anything he decided (all of §Decisions in the
   approved plan came from him directly).

**Never silently reverse a recorded decision.** That is how two agents start
fighting through a document.
