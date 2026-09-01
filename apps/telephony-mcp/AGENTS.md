# AGENTS.md — apps/telephony-mcp

Scoped rules for the voice-call MCP + gateway. Root `AGENTS.md` still applies.

**Start with [`HANDOFF.md`](./HANDOFF.md)** for current state, the live-call
proofs, the next feature (walkie-talkie thinking-sound loop, fully specced),
and the migration manifest (this tool is slated to move out of life-stack).

## Non-negotiable safety rules

1. **Never place, script, or automate a real phone call without explicit,
   current user authorization.** `voice_start_call` / `tel call` dial a
   real person and cost money. Tests must use the fake adapters
   (`tests/helpers.ts`) — the default suite makes no network calls.
2. **[RETIRED 2026-09-02]** This rule read: *"Never weaken the two-stage
   flow: prepare (expiring request) → start (explicit `confirm: true`),
   idempotent retry via `startedCallId`. Any change here needs tests proving
   no double dial."* RETIRED 2026-09-02 by D-5/D-25/D-38
   (`docs/plans/two-way-calling/DECISIONS.md`) — Phase B keeps the two stages
   (behaviour-neutral, D-25); Phase C ships the one-shot `place_call`
   (dryRun + idempotency preserved). The invariant that SURVIVES is:
   **dialing stays explicit, previewable, and idempotent** — and any change
   to the dial path still needs tests proving no double dial.
3. **Consent invariants are load-bearing** (`src/domain/consent.ts`): `never`
   is unrecordable; `manual` starts unrecorded and disclosure/recording are
   separate explicit tools that nothing invokes automatically. Keep the tests
   that pin these.
4. **Full phone numbers exist only in config.** Everything persisted or
   emitted (events, logs, MCP output, FTS) carries alias + last four. The
   redaction layer (`redactValue` from `@george43g/robustness`, wired in
   `src/log.ts`) guards logs — don't bypass `logger`.
5. **Public surface stays minimal**: `/twilio/status`, `/twilio/recording`,
   `/relay/<token>` — all X-Twilio-Signature-validated. Admin, metrics, and
   SSE bind 127.0.0.1 only. Never route admin through the public listener.
6. Secrets resolve by NAME via env → opkeep keychain. No `.env` files, no
   literal secrets in config, code, tests, or fixtures. Never log or store
   secret values, tunnel URLs, or recording plaintext.
7. Recordings stay AES-256-GCM encrypted at rest; audio bytes never cross
   MCP; deletion requires scope + confirmation.

## Working notes

- Single writer: the serve process owns the sqlite WAL DB; MCP/CLI mutate via
  the localhost admin API and read history through read-only connections.
- **Direct mode ("walkie-talkie"):** `mode: "direct"` on a call means the
  gateway runs NO LLM loop — it records the utterance and the MCP host replies
  verbatim via `voice_say` (→ admin `POST /calls/:id/say` → `session.sendText`).
  There is no LLM safety filter in this path: whatever the host sends is spoken
  to a real person. `voice_get_events` supports `waitMs` long-polling (≤55 s)
  so the host waits one call per turn instead of busy-polling. Keep the
  no-LLM-invocation invariant test (`tests/gateway.integration.test.ts`).
- Reserved adapter ids (`elevenlabs-managed`, `twilio-media-streams`) parse
  but must keep refusing construction until actually implemented.
- Narrow gate: `pnpm --filter telephony-mcp lint typecheck test`.
- Live/paid verification (tunnel install, smoke call, latency measurement) is
  gated on explicit authorization — see the ExecPlan.
