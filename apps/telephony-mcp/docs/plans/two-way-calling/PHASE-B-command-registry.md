# PHASE B — typed command registry (the spine)

> Read [`WORKSTREAM.md`](./WORKSTREAM.md) then [`DECISIONS.md`](./DECISIONS.md) first.
> Where this file and `WORKSTREAM.md` disagree, `WORKSTREAM.md` is correct.
>
> **This is the most consequential phase in the workstream.** C, D, G, H and every
> later conversation mode consume what it leaves behind. Getting `CallMode` wrong
> here costs a redesign in each of Q, R and T.

## Inherited invariants

| INV | How it constrains this phase |
|---|---|
| **INV-1** | No tool-name prefix; every name self-describing. Drives the rename table in Step 3. |
| **INV-5** | One definition per operation. This phase's entire reason to exist. Today: 13 MCP tool schemas (`src/mcp/server.ts`, `registerTool` at lines 72, 121, 149, 175, 199, 226, 251, 281, 313, 351, 373, 400, 424) **plus** a second, weaker definition in the admin route bodies (`src/gateway/admin-server.ts:121-177`). |
| **INV-6** | Parse, don't guess. Zod at every boundary. The admin boundary currently violates this — Step 5 has the receipts. |
| **INV-8** | Surface parity is structural. Console `help` and SDK types are *generated from* the registry, never hand-maintained. |
| **INV-9** | Single WAL writer. Adapters may add surfaces; they must not add a second writer. Read paths stay read-only sqlite (`src/mcp/server.ts:35`). |
| **INV-10** | Loopback-only for admin/metrics/events. Any new route needs a `DECISIONS.md` entry; none of this phase's routes are public. |
| **INV-11** | `redactValue` stays on every emitted event and tool payload (`src/mcp/server.ts:40`, `admin-server.ts:214`, `:217`). |
| **INV-13** | Recording deletion keeps scope + explicit confirmation; audio bytes never cross MCP. |
| **INV-14** | Default suite offline and free. The parity test in Step 11 must not dial. |
| **INV-16** | One merge at a time. |

Also binding: **D-5** (one-shot `call`, keep dryRun + idempotency, drop TTL), **D-6** (typed
registry, thin adapters), **D-8** (`AdminServer` inverted, not deleted), **R-7** (adding surfaces
beside the current AdminServer is rejected), **R-8** (REST becomes an adapter, is not deleted).

## Scope

1. One Zod-validated command definition per operation, in `src/commands/`.
2. `makeRegistry` + `buildDispatcher` from `@george43g/mcp-kit`.
3. Every surface becomes a thin adapter: **look up → validate → dispatch**.
4. Tool renames per INV-1: 13 names → 12.
5. Fix the "parse, don't guess" violation at the admin boundary (three demonstrable bugs, Step 5).
6. **Leave `CallMode` open and shaped for four modes + the consult loop.**

## Non-goals

- **Not removing the dial gate** (`src/domain/call-requests.ts:37-42`) — Phase C, D-3.
- **Not adding `dryRun` or the idempotency window** — Phase C. Phase B's `call` keeps today's dial semantics; only the *boundary* changes.
- Not touching the tunnel, daemon or launchd (Phase D).
- Not adding latency instrumentation (Phase E) or the `play` frame (Phase F).
- Not building the WS live-stream server or the SDK (Phase H) — but the registry must not preclude them.
- **Not implementing mid-call mode handoff** (Phase K). Phase B only stops entrenching the constructor read.
- **Not freezing `CallMode` member names** — blocked on O-2 (Step 8).
- Not deleting `/metrics` or `/healthz`, and not putting them behind the registry.

## KEPT VERBATIM (D-8) — do not touch, do not "clean up"

`AdminServer` is **inverted, not deleted.** These are transport concerns the registry has no opinion
about. Every line verified 2026-08-29.

| What | Where | Why it stays |
|---|---|---|
| Loopback-only bind | `src/gateway/admin-server.ts:224` — `this.server.listen(port, "127.0.0.1", …)` | INV-10. The single line that keeps admin off the tunnel. |
| Long-poll with full listener cleanup | `:183-199` — `clearTimeout` + `events.off` + `res.off("close")`, timer `unref()`'d | A leak here is a slow OOM on a long-lived daemon. Rewriting it is pure downside. |
| SSE redaction | `:214` and `:217` — `redactValue(event)` on backlog **and** live frames | INV-11. Two call sites; both required. |
| `CallServiceError.httpStatus` mapping | `:55-57` (thrown from `call-service.ts:28-35`) | Domain errors already carry 400/403/404/409/500/502. Re-deriving status in an adapter would fork it. |
| 256 KB body cap | `:28` | Pre-parse denial-of-service bound. Zod runs *after* the body is read; the cap must stay in front of it. |
| `/metrics`, `/healthz` | `:71-82` | Plain HTTP. Prometheus scrapes `text/plain; version=0.0.4`; a reverse-proxy probe wants a bare 200. **Neither fits the MCP tool shape.** |

## Steps

### 1 — `src/commands/` layout
One file per command, three exports, per mcp-kit's stated convention (`dist/tool-registry.d.ts`
docblock): *the Zod input schema, the Zod output schema, the `ToolDefinition`*.

```
src/commands/
  contracts.ts     shared Zod primitives (below)
  call.ts  end-call.ts  say-on-call.ts  set-recording.ts  play-disclosure.ts
  list-calls.ts  get-call.ts  get-call-events.ts  get-transcript.ts  search-calls.ts
  get-recording-metadata.ts  delete-recording.ts
  registry.ts      makeRegistry([...]) — the single source of truth
```

### 2 — `contracts.ts`: the schemas that today are implicit
Each of these exists today as an *ad-hoc coercion* in at least two places.

| Contract | Today's scattered copies |
|---|---|
| `CallIdSchema` | 7 regex route matches `/^\/calls\/([\w-]+)…$/` (`admin-server.ts:97,103,116,141,147,152,158`) |
| `RecordingScopeSchema` = `z.enum(["local","provider","both"])` | `admin-server.ts:167-170`, `mcp/server.ts:432`, `cli.ts:340-342` — **three copies** |
| `CallModeSchema` | `admin-server.ts:123-125`, `mcp/server.ts:93`, `cli.ts:153-155` — **three copies** |
| `SayTextSchema` = `z.string().min(1).max(2000)` | `mcp/server.ts:207` only; the REST path has **no** bound (`admin-server.ts:155`) |
| `ObjectiveSchema` = `z.string().min(1)` | `mcp/server.ts:82` only; REST has none — see Step 5 |
| `PaginationSchema` (`limit`, `beforeMs`) | `mcp/server.ts:258-259`, `admin-server.ts:87-93` |
| `ConfirmSchema` = `z.literal(true)` | `mcp/server.ts:129,434`, `admin-server.ts:138,174` |

### 3 — Name map (INV-1), ~~13 → 12~~ **13 → 13 in B** *(corrected 2026-09-02: this table predates D-25 — B stays behaviour-neutral, so `prepare_call`/`start_call` stay split here and Phase C does the D-5 merge into `place_call` per D-38/D-53)*
| Today (`src/mcp/server.ts`) | Phase B |
|---|---|
| `voice_prepare_call` (:73) + `voice_start_call` (:122) | **`call`** (merged — D-5) |
| `voice_end_call` (:150) | `end_call` |
| `voice_say` (:200) | `say_on_call` |
| `voice_set_recording` (:227) | `set_recording` |
| `voice_play_disclosure` (:176) | `play_disclosure` |
| `voice_list_calls` (:252) | `list_calls` |
| `voice_get_call` (:282) | `get_call` |
| `voice_get_events` (:314) | `get_call_events` |
| `voice_get_transcript` (:352) | `get_transcript` |
| `voice_search_calls` (:374) | `search_calls` |
| `voice_get_recording_metadata` (:401) | `get_recording_metadata` |
| `voice_delete_recording` (:425) | `delete_recording` |

> **The prompt-side count of "14 tools" is wrong — there are 13** (`grep -c registerTool` = 13; pinned
> at `tests/mcp.integration.test.ts:79-92`). The 13 cited line numbers are correct. The "14" also
> appears at `../2026-08-24-two-way-voice-brief.md:95` and should be corrected there.

**`call` semantics in Phase B are today's semantics behind one door**: alias-only recipient,
`confirm: true` still required, idempotency preserved via `CallRequest.startedCallId`
(`call-service.ts:107-110`). Phase C widens the recipient to E.164, adds `dryRun`, and drops the TTL.
Whether `confirm` survives Phase B is Q-B3.

### 4 — Registry + dispatcher
```ts
export const registry = makeRegistry([callCmd, endCallCmd, /* … 12 total */]);
export const dispatch = buildDispatcher({
  registry,
  engineLabel: () => "ts",
  onCall:  (name) => metrics.counter("tel_tool_calls_total", "Tool calls").inc(),
  onError: (name, err) => logger.warn("tool_error", { tool: name }),
});
```
No `devOnly` tools exist today, so `devOnlyEnabled` is **not** required — mcp-kit 1.0.0 throws only
when a `devOnly` tool is registered without it (verified in `dispatch.d.ts`). Adding a `get_logs`-style
tool later makes the predicate mandatory; see Q-B6.

This lands ledger row **L-4** from Phase A: every tool call gains a timeout, a perf span in `_meta`,
`AbortSignal` pass-through, and `noteActivity()` — none of which exists today.

### 5 — Fix "parse, don't guess" (INV-6). Three real bugs, not a style complaint.
The repo states the rule at `src/config/schema.ts:2-3` ("strictly validated at the boundary… parse,
don't guess") and honours it thoroughly for config. The admin boundary does not:

| Site | Coercion | Demonstrable consequence |
|---|---|---|
| `admin-server.ts:128` | `objective: String(body.objective ?? "")` | `POST /requests {"recipient":"george"}` creates a request with **`objective: ""`**. `prepareCallRequest` never checks it (`call-requests.ts:53`), so the call dials and the model receives `"Objective of this call: "` (`session.ts:41`). The MCP path is guarded by `z.string().min(1)`; **the REST path is not.** |
| `admin-server.ts:131` | `record: Boolean(body.record)` | `{"record":"false"}` → `true`. A JSON string flips recording **on** for a `preconsented` recipient. |
| `admin-server.ts:91` | `beforeMs: Number(beforeMs)` | `?beforeMs=abc` → `NaN`; `NaN ?? MAX_SAFE_INTEGER` does **not** substitute (nullish ≠ NaN), so `created_at_ms < NaN` matches nothing and the API returns an **empty list with HTTP 200** instead of a 400. |

Also: `say` has no length bound over REST (`:155`) while MCP caps at 2000 (`mcp/server.ts:207`), and
`endCall`'s `String(body.reason ?? …)` (`:144`) will persist `"[object Object]"` as `endReason`.

Not everything at this boundary is guessy — `waitMs` **is** clamped correctly (`:108`), and the two
enum checks (`:123-125`, `:167-170`) do reject. The problem is that the boundary is *inconsistent*,
which is exactly what one definition per operation removes.

**After Step 5, every field above is parsed by the same Zod schema the MCP surface uses.** Errors
become Zod issue paths, not silent defaults.

### 6 — Adapter: MCP-stdio
Replace `McpServer` + `registerTool` with the low-level `Server`
(`@modelcontextprotocol/sdk/server/index.js`; `McpServer` already exposes it as `.server`, verified
at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:18`):
- `ListToolsRequestSchema` → `registry.toMcpTools()`
- `CallToolRequestSchema` → `dispatch(name, args, signal)`
- The three resources (`mcp/server.ts:452,481,500`) → `buildResourcesHandler({ provider })`
- Transport → `startStdio({ server, entrypoint })`, which also lands Phase A ledger row **L-5**
  (shutdown, stdin-EOF, orphan watch, watchdog, heap monitor — none of which voice-mcp has today).
  The watchdog/long-poll hazard raised as Phase A's Q-A3 is resolved here: the dispatcher's
  `noteActivity()` now fires on every tool call, so a host parked in `get_call_events` is no longer
  invisible to the idle monitor. **Pin this with a test** (Step 11.6).

### 7 — Adapter: REST (`AdminServer`, inverted)
Keep the class, the KEPT-VERBATIM table above, and the existing URL shapes so `AdminClient`
(`src/client/admin-client.ts`) does not fork. Replace the **seven mutating route bodies**
(`admin-server.ts:121-177`) with a declarative table:

```ts
const ROUTES: Array<{ method: string; pattern: RegExp; command: string;
                      args: (m: RegExpMatchArray, body: unknown) => unknown }> = [
  { method: "POST", pattern: /^\/calls$/,                  command: "call",        args: (_, b) => b },
  { method: "POST", pattern: /^\/calls\/([\w-]+)\/say$/,   command: "say_on_call", args: (m, b) => ({ callId: m[1], ...(b as object) }) },
  // …
];
```
One shared handler does `registry.get(r.command)` → `def.input.parse(args)` → `dispatch` → JSON. Each
route is a declaration, not a body. `GET` read routes and the two streams stay as they are.

**Deliberately NOT adding `POST /commands/:name` in this phase** — a generic endpoint is the natural
home for the future SDK (Phase H) but it is a new surface, and INV-10 wants that argued on its own.
See Q-B2.

### 8 — ⚠️ THE CRITICAL SEAM: `CallMode`

Today: `export type CallMode = "llm" | "direct";` (`src/domain/types.ts:74`), branched on with string
equality at `session.ts:125` and `session.ts:137`, read **once** in the constructor
(`session.ts:39`), and narrowed by a cast when read back from sqlite (`sqlite-store.ts:210`).

Four modes are planned (own-agent / briefed-EL-agent / briefed-agent-with-consult-callback /
OpenRouter-model-with-EL-as-TTS-only) plus a mid-call consult loop.

**O-2 IS OPEN AND BLOCKS FREEZING THIS TYPE.** George retired "walkie-talkie" without naming a
replacement; the straw man in `DECISIONS.md:44` is `self` / `delegate` / `delegate+consult` /
`byo-model`. **Do not invent names.** Phase B ships the *shape*; O-2 fills in the *members*.

The shape — a **spec table**, so adding a mode is adding a row, not editing every `if`:

```ts
export const CALL_MODES = ["llm", "direct"] as const;      // implemented today
export type CallMode = (typeof CALL_MODES)[number];

export interface CallModeSpec {
  gatewayDrivesTurns: boolean;   // does OUR gateway run an LLM loop? (session.ts:137 branches on this)
  hostAnswersTurns:   boolean;   // does the MCP host answer each turn via say_on_call?
  mediaPathOffDevice: boolean;   // does ElevenLabs own the leg? (INV-7, D-20)
  supportsConsult:    boolean;   // may the call re-enter our MCP mid-turn? (D-19)
}
export const CALL_MODE_SPECS: Record<CallMode, CallModeSpec> = { … };
```

Rules this phase must land:
1. **No new string comparisons on `mode`.** `session.ts:137`'s `if (this.mode === "direct") return;` becomes `if (!spec.gatewayDrivesTurns) return;`. Same for `:125`.
2. `CallModeSchema` in `contracts.ts` is derived from `CALL_MODES` — one array, one enum, one persisted vocabulary.
3. **No migration needed to add modes.** The column is `mode TEXT NOT NULL DEFAULT 'llm'` with **no CHECK constraint** (`sqlite-store.ts:28`, ALTER at `:167`). Replace the cast at `:210` with a `CallModeSchema.safeParse` that falls back to `"llm"` on an unknown value, so an older binary reading a newer DB degrades instead of type-lying.
4. **Do not entrench the constructor read.** Move `session.ts:39` behind `private get modeSpec()` reading a mutable field, so Phase K adds a setter + event rather than restructuring the session.
5. `mediaPathOffDevice` exists so INV-7's hop diagram is a *property of the mode*, checkable in a test, rather than a diagram in a doc.

### 9 — Adapter: CLI
Every subcommand in `src/cli.ts` becomes `registry.get(name)` → `parse` → `dispatch` → cli-kit
`printAuto`. Deletes the duplicated `--mode` and `--scope` hand-validation (Phase A ledger rows
**L-9**, **L-10**). `history list|show|transcript|search` keep their read-only sqlite path (INV-9),
but their argument schemas come from the registry.

### 10 — Adapter: console
`runRepl({ prompt: "tel> ", dispatcher })` from `@george43g/cli-kit`, where `dispatcher.listTools()`
returns `registry.tools` and `callTool` is `dispatch`. **This is INV-8 made structural** — `help`
cannot drift because nothing hand-writes it. (Phase A ledger row **L-7**; Phase G builds the *view*, not this plumbing.)

### 11 — Delete the duplicates and prove it
Remove all 13 `registerTool` blocks and the seven inline body-coercion blocks. Then add tests.

## Verification

1. `pnpm --filter telephony-mcp lint typecheck test`; root `pnpm verify`.
2. **Parity test (INV-8, structural):** iterate `registry.tools` and assert each name is reachable from the MCP tool list, has a REST route entry, and appears in the console tool list. A command added to the registry with no adapter row fails the build.
3. **Golden pin** on the 12 tool names, replacing `tests/mcp.integration.test.ts:79-92`.
4. **Negative-parse tests** for each Step 5 bug: `POST /requests {"recipient":"george"}` → **400 with a Zod issue path**, not a created request; `{"record":"false"}` → 400; `?beforeMs=abc` → 400, not an empty 200.
5. **KEPT-VERBATIM regression tests:** admin listener refuses a non-loopback connection; N sequential long-polls leave `service.events.listenerCount("event")` unchanged (proves `:183-199` still cleans up); an SSE frame carrying a full number is redacted in both the backlog and live paths; a 300 KB body is rejected before parsing; `CallServiceError(…, 409)` still surfaces as HTTP 409.
6. **Dispatcher/watchdog test:** a `get_call_events` call with `waitMs` records activity, so the idle monitor does not consider a long-polling host idle (closes Phase A Q-A3).
7. **`CALL_MODE_SPECS` exhaustiveness:** `Record<CallMode, CallModeSpec>` makes a missing row a compile error; add a runtime test that every `CALL_MODES` member has a spec and that `session.ts` contains no remaining `=== "direct"` / `=== "llm"` string comparison.
8. **Unknown-mode degradation:** write `mode = 'delegate'` into a test DB, read it back, assert fallback to `"llm"` with a warn log rather than a throw.
9. **No new dependencies** beyond the two added in Phase A. **No paid call at any point.**
10. Docs: retire the "never weaken the two-stage flow" rule at `apps/*/AGENTS.md:15-17` **in this PR** (D-5 supersedes it — the brief flags it at `../2026-08-24-two-way-voice-brief.md:334-336`). Silently contradicting it is the failure mode `WORKSTREAM.md`'s *Changing an invariant* section exists to prevent.

## Seam left behind

| Left behind | Consumed by |
|---|---|
| `src/commands/registry.ts` — one definition per operation, Zod in and out | **every later phase**; C adds fields to `call.ts` rather than to two boundaries |
| `contracts.ts` shared primitives | C (E.164 recipient), D, G, H |
| `CALL_MODE_SPECS` + the predicate-based branches in `session.ts` | **Q, R, T** (each adds a row, not a redesign) and **K** (mid-call handoff flips a field) |
| Per-command Zod **output** schemas | **H** — the SDK's generated types (INV-8); the WS payload shapes |
| The dispatcher (`timeout / perf / abort / noteActivity`) + `startStdio` lifecycle | D (daemon supervision), H (MCP-HTTP reuses the same registry — D-7) |
| The declarative REST route table | H (adding a surface is adding a table, not a server) |
| `runRepl` console adapter | **G** (console view builds the rendering on top) |
| `mediaPathOffDevice` as a checkable property | INV-7 enforcement in Q/R/T |

## Open questions

| # | Question | Whose call | Blocks |
|---|---|---|---|
| **O-2** *(existing)* | Mode taxonomy. Four modes need one naming scheme. **`CallMode` cannot be frozen without it.** Phase B can ship the spec table with today's two members and a TODO, but every later phase then renames the members. | George | this phase, Step 8 |
| **Q-B1** | Do the *event type* strings (`turn.user`, `call.created`, …) join the registry as a typed union now, or stay free-form `string` (`domain/types.ts:43`) until Phase G needs to render them? | implementer | G, H |
| **Q-B2** | Add `POST /commands/:name` as a generic loopback surface now (thinner, and what the Phase H SDK wants), or keep only the per-resource route table? A new route wants a `DECISIONS.md` row under INV-10. | George | H |
| **Q-B3** | Does `confirm: true` survive Phase B on `call`, or does it go with the two-stage flow it belonged to? D-5 keeps dryRun + idempotency and is silent on `confirm`. The CLI's `--yes` (`cli.ts:179-181`) is a separate guard and can stay either way. | George | C |
| **Q-B4** | `structuredContent` is new output for every tool. Any host George uses that would be confused by it? (No external consumers exist; `private: true`.) | George (observation) | — |
| **Q-B5** | Should `mode` gain a sqlite CHECK constraint? Today there is none, which is what makes adding modes migration-free — a constraint would trade that for early detection. Recommendation: **no constraint**, use the Step 8.3 parse-with-fallback instead. | implementer | Q, R, T |
| **Q-B6** | Register a `devOnly` `get_logs` tool in this phase? It would make `devOnlyEnabled` mandatory on `buildDispatcher` (mcp-kit 1.0.0) and is genuinely useful for Phase E's latency work — but it is a new tool, not a refactor. | George | E |
