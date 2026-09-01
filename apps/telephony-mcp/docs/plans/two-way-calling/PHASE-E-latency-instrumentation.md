# PHASE E — latency instrumentation (measure before optimising)

> Read [`WORKSTREAM.md`](./WORKSTREAM.md) then [`DECISIONS.md`](./DECISIONS.md) first.
> Where this file and WORKSTREAM.md disagree, WORKSTREAM.md is right.
>
> **Paths** are relative to the app dir — `apps/voice-mcp/` today, `apps/telephony-mcp/`
> after Phase A. Line numbers are against the tree as read on 2026-08-29.

**One sentence:** direct mode has never been measured; this phase splits its
"a few seconds" into named legs, on metrics and on the event stream, so Phase F
knows how long to mask and Phase R knows what `response_timeout_secs` to set.

---

## Inherited invariants

| INV | How it binds this phase |
|---|---|
| **INV-5** | If Phase B has landed, the new timings read-path is **one** registry command with CLI/MCP/REST as adapters. Do not add a second `history timings` definition beside a registry entry. |
| **INV-6** | Every new query param and event payload is Zod-parsed. No `Number(x ?? 0)` on the admin boundary — that is the exact pattern Phase B is deleting. |
| **INV-9** | Only the `serve` process writes `timings`. CLI/MCP readers open the store read-only (`SqliteStore(path, { readonly: true })`, `src/cli.ts:233`). |
| **INV-10** | `/metrics` stays on the 127.0.0.1 admin listener (`src/gateway/admin-server.ts:78-82`, bind at `:224`). This phase adds **no** public route. |
| **INV-11** | Timing payloads carry integers and a turn number — never a number, never a URL. Marks go through `logger`, never `console`. |
| **INV-14** | Everything in Steps 1–8 is verified offline with the fake-WS harness. Step 9 is a real paid call and needs George's authorisation *at the time*. |
| **INV-16** | One merge, wait for the Release run, then the next. |

---

## Scope

1. **Fill the two never-filled marks in direct mode.** `handleTurn` writes
   `endOfTurnMs` and returns at `src/gateway/session.ts:137`, so
   `firstModelTokenMs` / `firstTokenToTwilioMs` stay `null` forever
   (`:127-134`). The reply arrives later through `sendText` (`:241-259`) — that
   is where the direct-mode marks belong.
2. **Add the leg the brief never modelled: host pickup lag.** The budget in
   `../2026-08-24-two-way-voice-brief.md:138-147` collapses "long-poll returns"
   into 5–20 ms and lumps everything after it into "the agent thinks". Those are
   two different failures with two different fixes. Measure them separately.
3. **Expose per-turn breakdown on the event stream** (`turn.timing`) so Phase G
   renders it live, and as metrics for the Prometheus scrape.
4. **A report that answers the question** — per-call and aggregate leg
   percentiles, read-only, from history.

### The legs, and which are actually observable

| Leg | From → to | Observable? | Where the mark goes |
|---|---|---|---|
| STT finalise | human stops → Twilio `prompt{last:true}` | **No.** The `prompt` frame carries no timestamp (`src/adapters/telephony/relay-messages.ts:16-23`); only `interrupt` carries `durationUntilInterruptMs` (`:29`). Stays an estimate. | — (document as unmeasurable) |
| ingest | `prompt` received → `turn.user` appended | yes | `session.ts` around `:122-134` |
| **pickup** | `turn.user` appended → the event is handed to a host | yes | admin `/calls/:id/events` responder (`admin-server.ts:103-115`) |
| **think** | event handed to host → `say` received | yes | `CallService.say` entry (`src/gateway/call-service.ts:250`) |
| egress | `say` received → `textFrame` on the wire | yes | `session.ts:243` |
| TTS first audio | frame → audible | **No** (Twilio/ElevenLabs side) | — |

`endOfTurn → egress` is the direct-mode analogue of llm mode's
`voice_first_token_to_twilio_ms` and is the number that goes head-to-head with
the measured llm p50 ≈ 714 ms.

---

## Non-goals

- **No optimisation.** Not one line that makes anything faster. If a leg looks
  bad, write the number down and stop.
- **No thinking sound** — that is Phase F, which edits the same file and must
  therefore not run in parallel (WORKSTREAM.md "Parallelism rules").
- **No change to llm-mode semantics.** `voice_first_model_token_ms` /
  `voice_first_token_to_twilio_ms` keep their current meaning and call sites
  (`session.ts:157-159`, `:174-176`), or the one measured baseline stops being
  comparable.
- **No Prometheus labels.** `Metrics` has no label support — `histogram(name, help)`
  keys on the bare name and `renderProm` emits bare series
  (`src/gateway/metrics.ts:59-66`, `:74-85`). Splitting by mode uses **distinct
  metric names**, not labels. Adding a label dimension is a separate change.
- **No metric rename.** Whether `voice_*` becomes `tel_*` with the package is an
  Open question (proposed **O-9**), not this phase's call.

---

## Steps

### 1. Store: two new marks (`src/stores/sqlite-store.ts`, `src/domain/types.ts`, `src/domain/ports.ts`)

Extend `TurnTiming` (`types.ts:93-100`) with `deliveredToHostMs` and
`replyReceivedMs`, both `number | null`. Add the columns to the `timings` DDL
(`sqlite-store.ts:89-96`) **and** to `migrate()` (`:164-171`) using the existing
try/catch `ALTER TABLE` idiom — the live DB predates them and
`CREATE TABLE IF NOT EXISTS` will not add columns to it. `upsertTiming`
(`:491-511`) already COALESCEs every field, so first-write-wins per column is
free; extend the INSERT/UPDATE column lists and `getTimings` (`:513-525`) row map.

> `upsertTiming`'s COALESCE means **a mark can never be overwritten**. That is
> the desired semantics for "first token" and it stays right for these two.

### 2. Session: a pending-turn box (`src/gateway/session.ts`)

`sendText` stamps `this.turn` (`:246`), which has already advanced if a new
`prompt` arrived while the host was thinking. Attributing a late reply to the
new turn understates think-time — the metric would lie *optimistically*, which
is the worst direction.

Add `private pendingDirect: { turn: number; endOfTurnMs: number } | null`, set
it in `handleTurn` immediately before the `:137` return, and have `sendText`
stamp against `pendingDirect.turn`. If `pendingDirect.turn !== this.turn`, still
record it but mark the emitted event `stale: true` and **do not** feed it to the
histograms. Clear `pendingDirect` in `sendText`, in `handleInterrupt`
(`:204-222`), and on `ws.on("close")` (`:55-60`).

### 3. Session: the direct-mode marks (`src/gateway/session.ts`)

In `sendText` (`:241-259`), before `ws.send` (`:243`), read `nowMs()` as
`replyReceivedMs`; after the send, read it again as `firstTokenToTwilioMs`. Gate
the whole block on `this.mode === "direct"` — read the field, don't cache a
boolean, because Phase K makes mode mutable. Map:

| Column | Direct-mode meaning |
|---|---|
| `firstModelTokenMs` | reply text reached the gateway (the host *is* the model) |
| `firstTokenToTwilioMs` | reply frame on the wire |
| `replyReceivedMs` | same instant as `firstModelTokenMs`, kept separate so the llm-mode column keeps one meaning |
| `deliveredToHostMs` | set by Step 4, not here |

`CallService.say` (`call-service.ts:250-257`) is a better anchor for "reply
reached the gateway" than `sendText`, but it has no turn context. Keep the mark
in `sendText`; the gap between the two is a `Map` lookup and an `await`.

### 4. Admin: the pickup mark (`src/gateway/admin-server.ts`)

In the per-call events handler (`:103-115`), after the events are resolved and
before `json(...)`, for each `turn.user` event in the batch call a new
`service.markDelivered(callId, turn, nowMs)` that writes `deliveredToHostMs`
(COALESCE ⇒ only the first delivery counts, so a re-poll of the same cursor
cannot reset it). Parse `turn` out of `event.data` with Zod (INV-6) — it is
`Record<string, unknown>` (`types.ts:44`).

Caveats to write into the code comment: this measures *a* host taking the event,
not *the* host; and a host that reads `?poll=1` on the global feed
(`:204-207`) or long-polls without ever calling `say` will still stamp it. Both
are fine for a single-agent setup and wrong for a multi-host one — that is
proposed Open row **O-10**.

### 5. Metrics (`src/gateway/metrics.ts` call sites only)

Four new histograms, named distinctly because there are no labels:

| Name | Observation |
|---|---|
| `voice_direct_pickup_ms` | `deliveredToHostMs - endOfTurnMs` |
| `voice_direct_think_ms` | `replyReceivedMs - deliveredToHostMs` |
| `voice_direct_egress_ms` | `firstTokenToTwilioMs - replyReceivedMs` |
| `voice_direct_turn_ms` | `firstTokenToTwilioMs - endOfTurnMs` (the headline) |

`HIST_BUCKETS_MS` tops out at 5000 (`metrics.ts:8`) — direct-mode turns are
expected to exceed that, so everything interesting lands in `+Inf` and the
histogram becomes useless. Pass an explicit bucket list for the direct
histograms (the constructor already accepts one, `:26-33`): e.g.
`[250, 500, 1000, 2000, 3000, 5000, 8000, 12000, 20000]`. Leave the shared
default alone so llm-mode series stay comparable.

### 6. Event: `turn.timing` (`src/gateway/session.ts`)

On completing a direct turn, `emit(callId, "turn.timing", { turn, mode, endOfTurnMs,
pickupMs, thinkMs, egressMs, totalMs, stale? })`. Integers and a turn number
only (INV-11). This is the seam Phase G renders — emit it for **llm** turns too,
derived from the existing marks, so the console has one event type to parse
rather than two code paths.

### 7. Read path (`src/gateway/admin-server.ts`, `src/cli.ts`, `src/mcp/server.ts`)

`GET /calls/:id/timings` on the admin listener returning `getTimings(callId)`
plus derived legs; a `timings <callId>` verb next to `history show`
(`cli.ts:249-262`, which already returns `s.getTimings(callId)`); aggregate
percentiles (p50/p90/p99 per leg, n, mode split) across the last N calls.
**If Phase B landed first, all three are one registry command** (INV-5).

### 8. Tests (`tests/gateway.integration.test.ts`, `src/stores/sqlite-store.test.ts`)

Extend the existing direct-mode block (`tests/gateway.integration.test.ts:372-441`);
it already drives prompt → `say` → frame assertions through the fake WS.

| # | Assertion |
|---|---|
| 8.1 | After a direct prompt + `say`, all four marks are non-null and monotonically ordered. |
| 8.2 | `deliveredToHostMs` is set by the events poll, and a **second** poll of the same cursor does not move it. |
| 8.3 | A reply arriving after a newer prompt is attributed to the older turn and flagged `stale: true`. |
| 8.4 | A turn with no reply leaves the later marks `null` and emits no `turn.timing` — no zeros, no NaN. |
| 8.5 | `/metrics` contains `voice_direct_turn_ms_bucket`; llm-mode series are unchanged (extends the existing check at `:360-364`). |
| 8.6 | Store migration: open a DB created without the new columns, assert `migrate()` adds them and old rows read back as `null`. |

### 9. The measurement run (paid, George-authorised — **not** part of the merge)

≥20 direct-mode turns on one live call, which has never been done
(`../2026-08-24-two-way-voice-brief.md:399-400`). Vary the agent's context size
between turns — leg 4 is dominated by the host's own model turn, so a fat
context and a lean one are different populations. Record the table in this file
under a `## Measured` heading, with the date and call id, and add the p50/p90 of
`voice_direct_turn_ms` to `DECISIONS.md` as the anchor Phases F and R cite.

---

## Verification

1. `pnpm --filter voice-mcp test typecheck lint` (`telephony-mcp` after Phase A).
2. Root `pnpm verify`.
3. Manual offline: `serve` + the fake harness, then `curl 127.0.0.1:<adminPort>/metrics`
   shows the four new series with sane buckets.
4. Confirm no new public route: the public listener's 404 surface is unchanged
   (`src/gateway/public-server.ts:118-125` and its existing rejection tests).
5. PR → CI → merge → **wait for the Release run** (INV-16).
6. Step 9 last, separately authorised, and it does **not** gate the merge.

**Falsification, stated up front:** the brief bets that direct mode is 2–10 s and
therefore that topology changes are pointless (`R-1`, `D-18`). If
`voice_direct_turn_ms` p50 comes back near 1 s, that bet is wrong, R-1 must be
re-opened, and Phase F's bed may be unnecessary. Phase E is the phase that is
allowed to embarrass the plan (brief §9.1, `:409-411`).

---

## Seam left behind

| Artifact | Consumed by |
|---|---|
| `voice_direct_{pickup,think,egress,turn}_ms` with real percentiles | **F** (bed start delay + escalation threshold), **R** (`response_timeout_secs`, min 5 s / max 300 s per D-19) |
| `turn.timing` event, one shape for both modes | **G** (live per-turn latency), later **I**/**J** |
| `TurnTiming.deliveredToHostMs` / `.replyReceivedMs` + migration | anything reasoning about host responsiveness — inbound routing (L–M) uses "is a host actually polling" as its liveness signal |
| `pendingDirect` box in `RelaySession` | **F** (the thinking-state machine hangs off the same box), **K** (mode handoff mid-turn) |

**Blast radius:** `session.ts`, `admin-server.ts`, `sqlite-store.ts`,
`types.ts`, `ports.ts`, `cli.ts`, plus tests. One additive DB migration on a DB
that holds the 2026-08-02 history (see O-6). No public-surface change, no
config-schema change, no MCP tool removed. Rollback = revert; the extra columns
are inert.

---

## Open questions

| # | Question | Who | Note |
|---|---|---|---|
| **O-9** (proposed) | Do `voice_*` metric names rename with the package (`tel_*`)? | George | Breaks any existing dashboard/scrape and orphans the 2026-08-02 baseline. Not this phase's call; flagged because this phase adds four more `voice_`-prefixed series. |
| **O-10** (proposed) | Pickup mark with more than one polling host: first poller wins, or per-host? | implementer | Single-agent today; L–M inbound makes it real. |
| — | Is any Twilio-side timestamp available to close the STT-finalise leg? | implementer | **unknown — verify against Twilio's ConversationRelay WebSocket-messages doc and the Call resource's timing fields.** Do not assume one exists. |
| — | Wall clock vs monotonic | implementer | All marks come from `systemClock` = `Date.now()` (`src/domain/ports.ts:29`). NTP slew can distort a multi-second delta. Keeping wall clock preserves cross-referencing with `event.tsMs`; if the measured spread looks impossible, re-measure with `performance.now()` deltas before believing it. |
| — | Should `turn.timing` be emitted for a turn that never got a reply (call ended mid-think)? | implementer | Step 8.4 says no. Revisit if G's rendering wants the gap made visible. |
