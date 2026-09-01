# PHASE C — open dialing

> Depends on **Phase B** (command registry). Parallel with **D** and **E**.
> [`WORKSTREAM.md`](./WORKSTREAM.md) outranks this file.

## Inherited invariants

| INV | How it binds this phase |
|---|---|
| **INV-2** | Dialing is not gated. Any valid E.164 dials. Config aliases become nicknames + defaults, never permissions. This phase's whole point. |
| **INV-3** | `src/domain/consent.ts` is **unchanged, byte for byte**. It governs recording only. Ad-hoc numbers get `recordingPolicy: "manual"` (D-4) — they connect instantly and start unrecorded. Its three tests stay pinned. |
| **INV-4** | Widening *who* can be reached adds no speech filter. Direct mode still speaks host text verbatim. Deliberate. |
| **INV-5** | `call` is defined **once**, in Phase B's registry. MCP / REST / CLI are adapters. Do not hand-roll a second definition. |
| **INV-6** | Zod at the boundary. `admin-server.ts:127-132` currently does `String(body.recipient ?? "")` — Phase B kills that; Phase C must land on the parsed shape, not re-introduce coercion. |
| **INV-9** | The serve process stays the single writer. Idempotency state is written there, never by the MCP/CLI client. |
| **INV-11** | **Hardest constraint in this phase.** An ad-hoc E.164 must never reach sqlite, FTS, events, logs or MCP output. Only alias + last four. There is no recovery once a number is persisted. |
| **INV-14** | No paid calls in the suite. `FakeTelephony` (`tests/helpers.ts:92-129`) records every dial. |

## Scope

1. Delete the dial gate at **both** layers (see Step 1 — there are two, not one).
2. Resolve a recipient from **either** a config alias **or** a raw E.164; synthesise an ephemeral recipient for the latter.
3. Collapse `prepare` + `start` into one-shot `call`, keeping `dryRun` preview and idempotency; drop TTL (D-5).
4. Keep `CallRequest` as load-bearing DATA — created-and-dialed in one step, still readable by `RelaySession`.

## Non-goals

- Recording policy changes. `consent.ts` is not touched.
- Name→number resolution via `~/.agents/humans/` (brief §4.3). Seam only.
- Inbound / caller resolution (Phases L–M).
- Mode semantics or the `CallMode` union — Phase B owns that.
- Removing `--yes` from the CLI (see Open questions).

---

## Steps

### 1. Delete the dial gate — it is in TWO places, not one

| Site | Code | Action |
|---|---|---|
| `src/domain/call-requests.ts:37-42` | `cfg.recipients[input.recipient]` → throw `unknown recipient alias` | delete; replace with `resolveRecipient()` |
| `src/gateway/call-service.ts:117-119` | `this.cfg.recipients[request.recipientAlias]` → throw `recipient vanished from config` | **delete** |

The second one is the trap. The brief calls the gate "6 lines"; it is not. `start()` re-reads config by alias at dial time to get `recipient.number` (`call-service.ts:156`) and `recipient.recordingPolicy` (`:135`). Delete only the first gate and every ad-hoc call creates a request, then dies at dial with `recipient vanished from config` — a gate removal that removes nothing.

The one-shot collapse is what makes this safe: the resolved recipient (with its full number) stays **in memory** from resolve to `telephony.createCall`, so nothing ever needs to re-read a number from the store. That is also how INV-11 survives.

### 2. `src/domain/recipients.ts` (new)

```ts
export interface ResolvedRecipient {
  alias: string;                 // config key, or `adhoc-<last4>`
  number: string;                // full E.164 — in-memory ONLY, never persisted
  displayName: string | null;
  recordingPolicy: RecordingPolicy;
  source: "config" | "adhoc";
}
export function resolveRecipient(cfg: Config, to: string): ResolvedRecipient;
```

Resolution order:
1. `cfg.recipients[to]` exists → config recipient, `source: "config"`.
2. `to` matches the `E164` regex (`src/config/schema.ts:13`) → `{ alias: adhocAlias(to), number: to, displayName: null, recordingPolicy: "manual", source: "adhoc" }` (D-4).
3. Otherwise → `CallRequestError`. **This is a parse failure, not a permission gate** (INV-6): "`mum` is neither a configured alias nor E.164 (expected `+<country><number>`)". Say so in the message, or the next reader re-reads it as the allowlist coming back.

Verified: the two namespaces cannot collide. Alias keys are `^[a-z0-9][a-z0-9-]*$` (`schema.ts:133`); E.164 always starts with `+` (`schema.ts:13`). No ambiguity, no precedence bug.

`adhocAlias(to)` = `adhoc-<lastFour>`. Verified safe: `recipient_alias` is a plain `TEXT` column in `call_requests` (`sqlite-store.ts:23`) and `calls` (`:39`) and is a key in nothing — collisions are cosmetic. (A config alias literally named `adhoc-1234` would shadow nothing, because Step 1 deletes the only by-alias config lookup on the dial path.)

### 3. `src/domain/call-requests.ts` — rewrite

- `prepareCallRequest` → `buildCallPlan(cfg, input): CallPlan` — pure, no store writes. Returns `{ recipientAlias, numberSuffix, displayName, profile, mode, recordingEnabled, recordingPolicy, maxDurationSec, source }`. This is what `dryRun` returns.
- `createCallRequest(plan, store, clock, ids): CallRequest` — persists.
- **Delete `resolveStartableRequest` (`:74-91`) entirely.** It exists only for stage 2. Its idempotency branch moves to Step 5.
- `initialRecordingState(...)` call at `:45-49` is unchanged and now receives `resolved.recordingPolicy` — for ad-hoc that is `"manual"`, so `record: true` on an ad-hoc number throws `ConsentError` from `consent.ts:27-33`. **The call still connects if the caller doesn't ask to record**; only the explicit "and record it" request is refused. Not a dial gate.

### 4. Drop TTL without breaking existing configs

| Site | Today | After |
|---|---|---|
| `src/config/schema.ts:120-121` | `callRequestTtlMinutes` w/ `.default(10)` | keep the key, `.optional()`, `/** @deprecated ignored since Phase C */`, read by nothing |
| `src/domain/types.ts:88` | `expiresAtMs: number` on `CallRequest` | remove from the type |
| `src/stores/sqlite-store.ts:32` | `expires_at_ms INTEGER NOT NULL` | **keep the column**; write `0` |
| `config.example.json` | sets `callRequestTtlMinutes: 10` | remove the line |

`ConfigSchema` is `.strict()` (`schema.ts:148`) — deleting the key outright would make George's live config fail to parse. Keeping it accepted-and-ignored is the only non-breaking move. Keeping the sqlite column matches the established migration style: `migrate()` (`sqlite-store.ts:165-171`) is **additive only** (`ADD COLUMN`), and old rows keep their values.

### 5. Idempotency — preserve the property, replace the mechanism

Today: `startedCallId` on the CallRequest, checked at `call-service.ts:107-110`. That only works because stage 2 hands back a request id. One-shot has no such handle, so the key must be derived.

**Key.** `HMAC-SHA256(installKey, e164 ‖ 0x00 ‖ objective ‖ 0x00 ‖ mode ‖ 0x00 ‖ profile)`, hex, truncated to 32 chars. `installKey` = 32 random bytes written once to `<stateDir>/idempotency.key`, mode `0600`, alongside the existing 0700 state layout (`paths.ts:24-31`).

Keyed, not a bare digest, **because a bare SHA-256 of a phone number is a reversible oracle** — the E.164 space is small enough to enumerate in seconds, and a persisted plain hash would be a number in the database wearing a hat (INV-11).

An explicit `idempotencyKey` input on `call` overrides the derived one, so a host can retry safely across its own restarts.

**Storage.** New table, additive migration:

```sql
CREATE TABLE IF NOT EXISTS call_idempotency (
  key TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
```

**Order of operations (this is the part that matters):**

1. Look up `key` where `created_at_ms > now - window`. Hit → return `store.getCall(call_id)`. **No dial.**
2. Miss → `INSERT` the key **before** dialing. If the INSERT hits the UNIQUE constraint, another caller won the race: re-read and return theirs.
3. Then dial.

Reuse the existing idiom verbatim — `recordProviderEvent` (`sqlite-store.ts:357-366`) already does insert / catch-UNIQUE / return-false for exactly this shape. Extend the seam, don't invent one.

Window: `limits.callDedupeWindowSeconds`, default `120`, added to `LimitsSchema` (`schema.ts:114-125`). Prune rows older than the window on insert.

Rejected alternative: dedupe on `(numberSuffix, objective)`. Two different people whose numbers end `1234` would silently swallow the second call. A missed call is worse than a double dial.

`startedCallId` and `markRequestStarted` stay and are still set — now always, immediately. Degenerate as a guard, free as a second layer, and `CallRequest` keeps its shape for readers.

### 6. One-shot `call` in `CallService`

`prepare()` (`call-service.ts:85-98`) + `start()` (`:100-178`) collapse into one method.

```
call({ to, objective, context?, profile?, record?, mode?, dryRun?, idempotencyKey? })
```

- `dryRun: true` → resolve + build the plan, return it, **persist nothing and create no request id.** A dryRun that returned a resumable id would be `prepare` under a new name (R-3). The plan carries `numberSuffix`, never `number`.
- Otherwise: resolve → idempotency check (Step 5) → concurrency check (`:111-116`, unchanged) → `createCallRequest` → `createCall` → `putRelayToken` → `telephony.createCall({ to: resolved.number, … })`.
- `CallRecord.recordingPolicy` comes from `resolved.recordingPolicy`, not from a config re-read.

**`CallRequest` stays load-bearing.** `RelaySession` reads `store.getCallRequest(call.requestId)?.mode` at `session.ts:39` and `?.context` at `:64-67`. The one-shot tool must still write the record — it just writes and dials in one step. Skipping the record silently breaks direct mode.

### 7. Surfaces (thin adapters over Phase B's registry — INV-5)

| File | Change |
|---|---|
| `src/gateway/admin-server.ts:121-140` | `POST /requests` + `POST /calls` collapse to one `POST /calls`. Body parsed by Zod (INV-6), replacing `String(body.x ?? "")` at `:127-132` and `:138`. **Phase B owns this route's shape — do not rewrite it by hand.** |
| `src/client/admin-client.ts` | `prepare()`/`start()` → `call()` |
| `src/mcp/server.ts:72-146` | `voice_prepare_call` + `voice_start_call` → one tool. Annotations: `destructiveHint: true`, `openWorldHint: true`, `idempotentHint: true` (it now genuinely is, within the window). Description must state: real, paid, real person. |
| `src/cli.ts:141-170` + `:172-189` | `prepare` + `call` → one `call <to>` with `--dry-run`. **Keep `--yes`** — it guards a typo at a terminal, not the callee's right to be reached. |
| `src/cli.ts:95-99` | `doctor` asserts `Object.keys(cfg.recipients).length > 0` as a **pass** condition. That is now wrong: an alias-free config is valid. Make it informational. |
| `src/config/schema.ts:133` | `recipients` becomes `.default({})` — aliases are optional now. |
| `AGENTS.md:15-18` | Rule 2 ("Never weaken the two-stage flow") is **consciously retired** per D-5. Replace with the idempotency + no-double-dial requirement, which is the part that was ever load-bearing. Do not just delete it. |
| `README.md:32`, `:66`, `:81-82` | Two-stage docs → one-shot. |

---

## Verification

`pnpm --filter telephony-mcp test typecheck lint` → root `pnpm verify`. No paid calls (INV-14).

**Must pass:**

| # | Test | Pins |
|---|---|---|
| 1 | ad-hoc E.164 absent from config dials; `FakeTelephony.log.calls[0].to === "+61400999888"` | INV-2, and that **both** gates are gone |
| 2 | ad-hoc call → `recordingPolicy: "manual"`, `recordingEnabled: false`, call still connects | D-4, INV-3 |
| 3 | ad-hoc + `record: true` → `ConsentError`, **and no dial** | INV-3 |
| 4 | config alias with policy `never` still unrecordable; `src/domain/consent.test.ts` unchanged | INV-3 |
| 5 | `to: "mum"` → parse error, `log.calls.length === 0` | INV-6 |
| 6 | `dryRun: true` → no `calls` row, no `call_requests` row, no dial; plan has `numberSuffix`, no `number` | D-5 |
| 7 | two identical `call()`s → **one** entry in `log.calls`, same `call.id` both times | D-5, the billing invariant |
| 8 | `Promise.all([call(x), call(x)])` → still one dial | the race in Step 5 |
| 9 | same number, different objective → two dials | dedupe isn't over-broad |
| 10 | `FixedClock.advance(window+1)` then repeat → two dials | window works |
| 11 | `RelaySession` still reads `mode` and `context` off the request created by one-shot | `session.ts:39`, `:64-67` |
| 12 | `maxConcurrentCalls` still refuses the second live call | `call-service.ts:111-116` |
| 13 | **Leak scan**: after an ad-hoc call, the full E.164 appears in **zero** bytes of the sqlite file, zero events, zero captured log lines | INV-11 |

Test 13 is the one with no recovery path if it is skipped. Implement it as a byte-scan of the DB file plus a `logger` capture, not as a field-by-field assertion.

**Rewrite:** `src/domain/call-requests.test.ts:32` (TTL), `:37` (allowlist rejection — invert it), `:77` (TTL expiry — delete), `:86` (started-never-expires); `tests/mcp.integration.test.ts:97` (`idempotentHint`), `:143` (`expiresAtMs`), `:180-186` (`/allowlisted/` — invert).

---

## Seam left behind

| Artefact | Consumed by |
|---|---|
| `resolveRecipient()` + `ResolvedRecipient` | **L–M (inbound)** resolve a *caller* through the same shape; the join point for reusing `handle-normal.ts` (brief §4.3) |
| One-shot `call` with an open `mode` field | **Q / R / T** — every later mode dials through this command unchanged. It must not assume two modes. |
| `call_idempotency` table + keyed-hash helper | any future "must not happen twice" — notably cold-spawn caps (D-16) |
| `dryRun` plan object | **G / I / J** — the "what would happen" preview in console, TUI and SPA |
| No-number-in-store discipline | everything downstream: once one E.164 lands in FTS, INV-11 is gone |

## Blast radius

If this phase is wrong:

- **Double dial** — a retried tool call rings a real person twice and bills twice. The single most likely failure, and the reason idempotency is preserved rather than dropped with the TTL.
- **Second gate missed** — every ad-hoc call fails at dial with `recipient vanished from config` (`call-service.ts:117-119`). Looks like the phase shipped; nothing works.
- **Number leak** — an ad-hoc E.164 written to `calls`, `call_requests`, `calls_fts` or an event is **unrecoverable**. FTS rows are not redactable after the fact and history is George's real call log.
- **Request record dropped** — direct mode silently degrades to `llm` mode, because `session.ts:39` falls back to `?? "llm"` when the request is missing. A live call answered by the wrong brain, with no error anywhere.
- **Consent widened by accident** — if `initialRecordingState` stops seeing `"manual"` for ad-hoc, a stranger gets recorded. That is a legal exposure in an all-party-consent jurisdiction (brief §5).

## Open questions

| # | Question | Whose call |
|---|---|---|
| C-a | **Tool name.** D-5 and the seam map say `call`. INV-1's own test rejects bare verbs (`say_on_call`, not `say`) — `call` is a bare verb. `place_call` / `start_phone_call`? | George / DECISIONS |
| C-b | Does the CLI keep `--yes` on one-shot `call`? INV-2 is about reachability, not typo protection — but it is a confirmation flag surviving a phase that deletes a confirmation flag. | George |
| C-c | `limits.maxConcurrentCalls` defaults to `1` (`schema.ts:116`). Now that dialing is easy, is 1 still right? | George |
| C-d | `tel doctor` currently *passes* on "recipients > 0" (`cli.ts:95-99`). Informational, or dropped entirely? | implementer |
| C-e | Should `to` eventually accept a person's name resolved via `~/.agents/humans/`? Out of scope here; the seam is `resolveRecipient`. | later phase |
| C-f | Dedupe window default: 120 s proposed. Long enough for a host retry, short enough that "call them again" works. Unvalidated. | implementer (measure) |
