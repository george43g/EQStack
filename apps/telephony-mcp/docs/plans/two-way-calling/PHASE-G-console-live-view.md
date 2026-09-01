# PHASE G — console live view

> Read [`WORKSTREAM.md`](./WORKSTREAM.md) then [`DECISIONS.md`](./DECISIONS.md) first.
> Depends on **B** (registry) and **E** (`turn.timing`); runs after **F** so the
> `thinking.*` markers exist to render.
>
> **Paths** are relative to the app dir (`apps/telephony-mcp/` after Phase A).
> Line numbers are against the tree as read on 2026-08-29.

**One sentence:** watch both sides of a live call in a terminal — speaker-labelled
turns, call state, barge-in markers and Phase E's per-turn latency — built as an
interactive console, on parsing and rendering primitives the TUI and web SPA
inherit rather than re-implement.

---

## Inherited invariants

| INV | How it binds this phase |
|---|---|
| **INV-1** | Console verbs are self-describing without a prefix, and mirror the registry's operation names. |
| **INV-5** | The console is a **thin adapter**: look up → validate → dispatch. It defines no operation of its own. View-only verbs (`follow`, `clear`) are console-local *view state*, not operations — say so explicitly so the next agent doesn't "promote" them. |
| **INV-6** | Events arrive as `Record<string, unknown>` (`src/domain/types.ts:36-45`). **Parse them with Zod, don't index into them.** A renderer that reads `e.data.text as string` is the same bug class INV-6 names. |
| **INV-8** | `help` is **generated from the registry**, not hand-written. Any hand-maintained command list here is wrong by construction. |
| **INV-9** | Console reads through the loopback API or a read-only store handle. It never opens the WAL for writing. |
| **INV-10** | Console talks to `127.0.0.1:<adminPort>` only. It adds nothing to the public listener. |
| **INV-11** | Rendered output carries alias + last four. The console must consume the **redacted** stream (see the asymmetry below) and must never re-derive a number from anywhere. |
| **INV-14** | Every test feeds the parser a string and the model an array — no sockets, no gateway, no calls. |

---

## Where this starts, precisely

`tel watch` today is a byte pump: `src/cli.ts:206-227` opens
`GET /events?after=N`, and the body loop is
`process.stdout.write(decoder.decode(chunk, { stream: true }))` (`:221-223`).
There is **no parsing at all** — no SSE framing, no cursor tracking, no
reconnect, no rendering. Everything in this phase is new work on top of a
working transport.

### What the gateway already gives us

| Source | Line | Notes |
|---|---|---|
| Global SSE | `admin-server.ts:83-85` → `handleEvents` `:202-221` | writes `id: <event.id>` + `data: <json>`; replays from `?after=` first (`:213-215`), then streams live (`:216-218`) |
| Global cursor batch | `handleEvents` `:204-207` (`?poll=1`) | for clients that can't hold a stream |
| Per-call events + long-poll | `:103-115` (`waitMs` ≤ 55 s) | the same channel direct-mode agents use |
| Transcript | `:116-119` | `GET /calls/:id/transcript` |
| Redaction | `redactValue` at `:214` and `:217` | SSE only — see below |

### Three things that are **not** true of the stream (verify these before designing around them)

1. **Assistant text is not on the event stream.** `turn.assistant` carries
   `{ turn, chars, interrupted }` (`session.ts:236`) and, on the verbatim path,
   `{ turn, chars, interrupted, verbatim }` (`:253-258`). **No text.** So a live
   transcript needs `GET /calls/:id/transcript` for the agent's side, in both
   modes. Only the *user* side is inlined, and only in direct mode
   (`session.ts:121-126`).
2. **`Last-Event-ID` is ignored.** `handleEvents` reads only `?after=`
   (`:203`). Reconnect must re-request with the last id the client saw.
3. **`?poll=1` and `/calls/:id/events` are NOT redacted** — `:205` and `:114`
   return store rows straight to JSON, while SSE runs them through `redactValue`.
   The console must use the redacted path, and the asymmetry should be fixed at
   the registry boundary in Phase B (proposed **O-13**).

---

## Scope

Three layers, in dependency order. **Layers 1 and 2 are the seam** — they must
not import anything console-specific (no `process.stdout`, no colour, no cli-kit).

| Layer | New file | Contents |
|---|---|---|
| 1 · transport + parse | `src/events/sse-parse.ts` | incremental SSE parser: buffer across chunk boundaries, split on `\n\n`, read `id:`/`data:`, Zod-validate into `CallEvent`, surface malformed frames rather than dropping them |
| 1b · client | `src/events/event-feed.ts` | async iterator over the feed: cursor tracking, reconnect with backoff re-issuing `?after=<lastId>`, `?poll=1` fallback, cancel via `AbortSignal` |
| 2 · model | `src/events/call-model.ts` | **pure reducer** `(state, CallEvent) => state`: calls, their status, per-call turns with speaker/role, barge-in markers, `thinking.*` state, Phase E's `turn.timing` legs |
| 3 · render | `src/console/render.ts` | line renderers over layer 2's state, using cli-kit's TTY/colour helpers; degrade to plain text when not a TTY |
| 3b · console | `src/console/repl.ts` | the interactive surface; `help` generated from the registry |
| 3c · CLI | `src/cli.ts` | `watch` re-pointed at layers 1–3 with `--format pretty\|json\|raw` |

`--format raw` keeps today's byte-pump behaviour so nothing that pipes `tel
watch` into `jq` breaks.

## Non-goals

- **No TUI.** No Ink, no full-screen, no alternate screen buffer. That is Phase I,
  and it consumes layers 1–2.
- **No web SPA / SDK** (Phase J) — but layers 1–2 must be importable by it, which
  is why they carry no Node-terminal dependency beyond `fetch`.
- **No new admin route.** If layer 2 turns out to need a merged
  `turns?afterTurn=` endpoint, that is a Phase B/H registry command, recorded
  here as a finding — not smuggled in.
- **No writes from the render path.** `say` / `end` in the console dispatch
  through the registry like any other adapter.
- **No `voice_get_events` change.** The agent-facing long-poll contract stays as
  documented at `src/mcp/server.ts:314-350`.

---

## Steps

### 1. SSE parser (`src/events/sse-parse.ts`)

A class or generator taking `Uint8Array` chunks and yielding events. The bug this
exists to prevent: **a frame split across a chunk boundary.** Today's code cannot
notice (it writes bytes through), so this has never been exercised. Buffer the
tail, split on the blank-line terminator, and only then decode. Zod-parse each
`data:` payload into `CallEvent` (`types.ts:36-45`); on failure yield a typed
`{ ok: false, raw }` so a bad frame is visible instead of silently vanishing
(same posture as `parseRelayMessage`, `relay-messages.ts:60-80`).

### 2. Feed client (`src/events/event-feed.ts`)

Wrap the parser: hold `lastId`, reconnect with backoff on stream end, re-issue
`?after=<lastId>` (Step "3 things", item 2), fall back to `?poll=1` polling when
the stream cannot be held. Accept an injected `fetch` (mirrors `AdminClient`'s
`fetchImpl`, `src/client/admin-client.ts:30`) so tests need no socket. Surface a
`GatewayUnavailableError` on connection refusal, exactly as `AdminClient` does
(`:44-46`) — "the gateway isn't running" is a first-class, user-fixable state and
the console must say so, not hang.

Add the missing `AdminClient` method while here: the SSE stream is the one part
of the admin API with no client method (`admin-client.ts` has `pollGlobalEvents`
at `:127-129` but nothing for the stream — which is why `cli.ts:213` inlines a
raw `fetch`).

### 3. Call model (`src/events/call-model.ts`)

A pure reducer, no I/O, so the TUI and SPA can run it against the same events.

| Event | Effect on state |
|---|---|
| `call.created` / `call.<status>` / `call.ended` | call row: alias, suffix, status, mode, timestamps |
| `session.setup` / `session.closed` | live-session flag (the difference between "dialed" and "someone is on the line") |
| `turn.user` | new turn, speaker = callee; `data.text` present ⇒ direct mode ⇒ show it; absent ⇒ mark "text pending" |
| `turn.assistant` | turn's agent side; **text always pending** (see finding 1) |
| `turn.interrupted` | barge-in marker on the current turn, with `spokenChars` |
| `turn.timing` (Phase E) | the per-turn leg breakdown |
| `thinking.*` (Phase F) | a "…thinking" marker between the caller's line and the reply |
| `recording.*`, `disclosure.played`, `llm.error`, `llm.fallback`, `session.bad_frame` | status-line annotations |

**Text hydration.** Because assistant text never rides the stream, the model
exposes a `pendingText: {callId, turn}[]` set; the *feed layer* (not the reducer)
fetches `GET /calls/:id/transcript` when it is non-empty, debounced (~250 ms),
and feeds the utterances back in as a second input. Keep the reducer pure —
hydration is I/O and lives outside it.

### 4. Renderers (`src/console/render.ts`)

Line-oriented, one function per state slice, so the TUI can reuse the *model* and
swap the *renderer*:

```
14:32:07  ▸ call c-8f3a  george ···1222  direct  answered
14:32:11  ‹george›  Hey Claude, can you hear me?
14:32:11  … thinking (stage 1)
14:32:14  ›claude‹  Loud and clear.               2.9s  pickup 12ms · think 2.8s · egress 41ms
14:32:19  ‹george›  ⟂ barge-in after 34 chars
```

Constraints: colour and box-drawing come from cli-kit's TTY helpers and must
degrade when `!process.stdout.isTTY`; no line may print a full number (INV-11);
timestamps are local; the latency column comes from `turn.timing` and is simply
absent on a gateway older than Phase E — never rendered as `0ms`.

### 5. The console (`src/console/repl.ts`)

`tel console` starts the interactive REPL from `@george43g/cli-kit@2.0.1`
(verified published: `npm view @george43g/cli-kit versions` → `… 2.0.0, 2.0.1`;
its description names "Commander helpers + TTY/color/output utilities + env↔flag
binder + **interactive REPL**"). **Its exact API is unknown — verify against the
installed `node_modules/@george43g/cli-kit/dist/index.d.ts` before writing
against it**; do not code from the description.

George's framing, to be honoured literally: *"a custom prompt interface in the
terminal where you send the word `help` to see options, somewhat mimicking the
MCP tool API surface."* So the prompt's verbs are the registry's operation names
(`call`, `say_on_call`, `end_call`, `list_calls`, …), argument parsing is the
registry's Zod schemas, and errors render like the API's errors.

| Verb kind | Source | Example |
|---|---|---|
| operations | Phase B registry — dispatched, never redefined (INV-5) | `call`, `say_on_call`, `end_call` |
| view state | console-local, and **documented as not operations** | `follow <callId>`, `unfollow`, `clear`, `quit` |
| `help` | **generated** by walking the registry (INV-8) | `help`, `help say_on_call` |

The live view runs *behind* the prompt: incoming lines print above the input line
without eating a half-typed command. If cli-kit does not provide that
(readline redraw on async output), it is the one thing worth writing by hand —
and if it can't be done cleanly, split into `tel watch` (stream, no prompt) and
`tel console` (prompt, `follow` prints a bounded tail), rather than shipping a
prompt that mangles input.

### 6. `watch` becomes an adapter (`src/cli.ts`)

Replace the body at `:210-226` with layers 1–3 and `--format pretty|json|raw`
(default `pretty` on a TTY, `json` when piped). `raw` preserves today's exact
bytes. The CLI stays scriptable/headless; the console is the interactive twin.

### 7. Tests (`tests/` + colocated unit tests)

| # | Assertion | Layer |
|---|---|---|
| 7.1 | A frame split across two chunks parses as one event; a frame split *inside* a UTF-8 sequence still decodes | 1 |
| 7.2 | `id:` is tracked; after a simulated disconnect the next request carries `after=<lastId>` and no event is replayed twice or dropped | 1b |
| 7.3 | Malformed `data:` yields a typed parse failure, does not throw, does not stop the stream | 1 |
| 7.4 | Reducer over a recorded event fixture produces the expected turn list — golden test, same events for console/TUI/SPA | 2 |
| 7.5 | An `llm`-mode `turn.user` (no `text`) renders as pending, never as an empty line | 2/3 |
| 7.6 | Renderer output contains alias + last four, never a full number, for a fixture built from `testConfig()` numbers | 3 |
| 7.7 | `help` output equals the registry's command list — a command added to the registry appears with no console edit (this is the INV-8 test) | 3b |
| 7.8 | Gateway not running ⇒ `GatewayUnavailableError` message, exit code, no stack trace | 1b/3c |
| 7.9 | `--format raw` byte-identical to today's output for a given input stream | 3c |

Fixtures: capture a real event sequence from the existing fake-gateway harness
(`tests/gateway.integration.test.ts:372-441` already drives a full direct-mode
call) and commit it as JSON. No network (INV-14).

---

## Verification

1. `pnpm --filter telephony-mcp test typecheck lint`; root `pnpm verify`.
2. Manual, offline: run the gateway with the fake adapters, drive a scripted call
   through the harness, and watch `tel console` render it — this is the whole
   feature and it needs **no paid call**.
3. Manual, live (optional, authorised): during a real direct-mode call, confirm
   the console shows both sides with the right latency column. Nice to have; not
   a merge gate.
4. INV-11 spot check: `rg` the rendered fixture output for `+61`.
5. PR → CI → merge → **wait for the Release run** (INV-16).

---

## Seam left behind

| Artifact | Consumed by |
|---|---|
| `src/events/sse-parse.ts` + `event-feed.ts` (cursor, reconnect, poll fallback) | **I** (TUI), **J** (web SPA — same parser over `EventSource`/WS), **H** (WS live streams reuse the cursor semantics) |
| `src/events/call-model.ts` — pure reducer, zero terminal deps | **I**, **J**. If either one re-implements this, the seam failed. |
| Text-hydration contract (assistant text is never on the stream) | **I**, **J**, and Phase B/H if a merged `turns` endpoint is ever added |
| `--format raw\|json\|pretty` split | scripts and anything piping the CLI |
| Rendering vocabulary (speaker labels, barge-in glyph, latency column) | **I**, **J** — visual consistency across surfaces is cheaper decided once |

**Blast radius:** one rewritten CLI command (`watch`), five new files, one new
dependency (`@george43g/cli-kit`), one added `AdminClient` method. No gateway
behaviour change, no schema change, no public surface change, no MCP tool change.
Rollback = revert; nothing else reads the new modules yet.

---

## Open questions

| # | Question | Who | Note |
|---|---|---|---|
| **O-13** (proposed) | Redaction asymmetry: SSE redacts (`admin-server.ts:214`, `:217`); `?poll=1` (`:205`) and `/calls/:id/events` (`:114`) do not. Which is the contract? | implementer → Phase B | The console must not be the thing that decides. Note MCP's own read path redacts separately (`src/mcp/server.ts:510`), so the store rows are plainly *intended* to be redacted on the way out. |
| **O-14** (proposed) | Should assistant utterance text ride `turn.assistant` instead of forcing a transcript fetch? | implementer → Phase B | Cheaper for every surface; costs a bigger event log and a second copy of the text. Deliberately deferred, not silently skipped. |
| — | Does cli-kit's REPL support printing async output above a live prompt? | implementer | **unknown — verify against the installed `dist/index.d.ts`.** Step 5 has the fallback if it does not. |
| — | Does the console need a "which call am I following" default when exactly one call is live? | George (taste) | Auto-follow the single live call is probably right; auto-follow with two live calls is definitely wrong. |
| — | SSE has no keepalive comment frames; an idle stream may be dropped by an intermediary | implementer | Irrelevant on loopback (INV-10 keeps it there). Becomes real only if H exposes the stream beyond loopback — record it there, don't pre-solve it here. |
