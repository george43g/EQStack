# Harness proposal — multi-phase workstream continuity

**For George, to absorb into `~/dotfiles/shell/.agents/skills/` later if it earns
its place.** You asked for this only if it is genuinely worth it, so the case is
argued rather than asserted, and §4 says when to skip it.

Live pilot: `apps/telephony-mcp/docs/plans/two-way-calling/` (the `telephony-mcp`
workstream, started 2026-08-29). Everything below is running there now.

## 1. The gap — stated honestly, because it is narrower than it first looks

The problem: **a workstream split into many fine-grained phases, where each phase
starts from a fresh context.** Phase K's agent has never seen Phase B. It reads its
own plan file, opens the code, and finds a design it did not choose. The failure
mode is not laziness — it is a reasonable agent improving something it cannot see
the reason for, and silently reversing a decision you made three phases ago.

Four existing skills each cover part of this. None covers that.

| Skill | Covers | Why it does not close this gap |
|---|---|---|
| `precompact` | Checkpointing state before a summary boundary | **Within one session's own memory.** Retrospective by construction — `Done`/`Open`/`Tree` describe what happened, not what must stay true |
| `handoff` | State for a reader with no history | Closest of the four, and genuinely overlapping. But it is **one-to-one and one-shot**: session N hands to session N+1. It does not bind five *not-yet-started* phases to a shared design, and its schema has nowhere to put "this must remain true for everyone" |
| `querying-peer-agents` | Cross-agent query contract + the Settled/Open/Rejected record | Peers are **concurrent**. The record is reusable here (see layer 2) but the skill's framing is another agent you are talking to *now*, not one that starts next week |
| `harness-engineering` | Repo legibility, encoded invariants, checked-in ExecPlans | Genuinely adjacent — "use a checked-in ExecPlan for multi-hour, cross-domain work" is close. But an ExecPlan is **one self-contained document updated in place**, scoped to a repo. It has no notion of *N sibling phase files* or of what phase X owes phase Y |

**So the honest claim is not "nothing covers this."** It is: `handoff` and
`harness-engineering` between them cover ~70% of the material, but neither is
*prospective* (written before the work, constraining work not yet begun) and neither
has a **producer/consumer contract between phases**. Those two properties are the
delta, and they are what the pilot adds.

## 2. The mechanism — three layers, all created before any code

**Layer 1 — `WORKSTREAM.md`: numbered invariants + a seam map.**

Invariants are numbered (`INV-7 — the orchestrator sits at the end of the chain,
never in the media path`) so a phase file can *cite* one and a reviewer can *name* a
violation. Unnumbered prose invariants get paraphrased and drift.

The seam map is the part nothing else has: a table of **what each phase leaves
behind, and which later phase consumes it.**

| Phase | Leaves behind (the seam) | Consumed by |
|---|---|---|
| B command registry | The registry + `CallMode` **as an open union sized for 4 modes** | C, D, G, H, and every later mode |
| G console view | Event-stream parsing + rendering primitives | I (TUI), J (web SPA) |

That table is what stops Phase I re-parsing the event stream Phase G already parsed.
Its real function is preventive: it makes "am I about to redo earlier work?" a
lookup instead of a judgement call.

**Layer 2 — the decision record, reused unchanged.** `Settled` / `Open` / `Rejected`,
every row anchored to a SHA, `file:line`, command output, or a dated attribution to
you. This is your existing convention from `querying-peer-agents`, pointed at a new
axis: **the same workstream over time** rather than different agents at once.
`Rejected` is what stops phase 9 re-proposing what phase 2 already killed — in the
pilot it is already holding eight dead options with reasons — including `R-1`, an
edge function as a latency fix, which a later phase would otherwise re-propose on
plausible-sounding grounds.

**Layer 3 — typed contracts landed early.** Land the shared types in the first build
phase so later divergence **fails to compile** rather than being caught in review. In
the pilot this is one type: `CallMode`. It is stated twice in `WORKSTREAM.md` on
purpose, because four modes exist in the plan and two exist in code, and every later
mode phase will be tempted to redesign it.

**Conventions that carry the layers.** Every phase file opens with
`## Inherited invariants` citing the INV-numbers it depends on, and a read-order
checklist (`WORKSTREAM.md` → `DECISIONS.md` → own file → *only then* code).
`WORKSTREAM.md` declares that it outranks any phase file.

**Redesign is explicitly allowed.** This is the part that keeps the mechanism from
becoming bureaucracy: a phase that finds a real flaw may change an invariant — it
just has to add a `Settled` row with the reason, move the superseded decision to
`Rejected`, update the invariant in place with a date, and flag it to you if it
touches something you decided. The rule is not "nothing changes", it is **"nothing
changes silently."**

## 3. Cost

- **Three artifacts per workstream**, plus a header on every phase file. Roughly a
  session to write; the pilot's two came to 255 lines before any phase file existed
  (`wc -l WORKSTREAM.md DECISIONS.md` → 188 + 67).
- **They must be maintained.** A stale `WORKSTREAM.md` that claims to outrank phase
  files is *worse than none* — it authoritatively asserts something false to an agent
  with no way to check. Mitigation, and I would make it a rule: **every invariant
  carries a date, and changing one is an edit to that file in the same PR** as the
  code that changed it.
- **A real risk of decision-theatre**: rows added to look rigorous that nobody reads.
  The pilot's guard is the anchor requirement — an unanchored row does not count.

## 4. When it is NOT worth it

- **Single-phase work, or anything one context can hold.** The whole cost buys
  cross-context continuity. If there is no second context, you have bought nothing.
- **Two or three phases.** `handoff` already does this well and cheaply. My rough
  threshold is **five-plus phases, or any phase graph with parallel branches** — the
  pilot has ~20 across two passes with three parallel lanes.
- **Exploratory work where the design is discovered rather than specified.** Writing
  invariants before you know them produces confident wrong constraints, which is a
  worse failure than drift.
- **Solo, continuous, same-week work.** The mechanism pays for context *loss*.

## 5. Recommendation

Worth adopting, **as an extension of `handoff` rather than a fifth independent
skill.** `handoff` already owns "writing for a reader with no history"; this is that
same discipline turned forward in time and fanned out to N readers. Adding it as a
section there — "when the work is a multi-phase workstream, also write
`WORKSTREAM.md` (invariants + seam map) and reuse the decision record" — keeps one
retrieval path and avoids two skills fighting over the same trigger phrase.

Let the `telephony-mcp` workstream run first. The evidence to judge it on is
specific: **does any phase agent redesign an earlier phase's work, and if it does,
is the redesign recorded?** If phases land without silent reversals, the mechanism
paid. If it turns out the phase files alone would have been enough, that is a real
result too, and cheaper to learn here than across three repos.
