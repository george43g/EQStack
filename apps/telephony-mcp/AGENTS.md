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
   `/relay/<token>` — all X-Twilio-Signature-validated — plus, with consult
   configured, exactly one route on its own loopback listener and hostname:
   `POST /v1/consult` (`src/gateway/tool-server.ts`), guarded by a per-call
   bearer (hash only, deleted when the call ends), a conversation-id match and
   an ElevenLabs source-IP allowlist (INV-10 as amended by D-91). Admin,
   metrics, and SSE bind 127.0.0.1 only. Never route admin through a public
   listener.
6. Secrets resolve by NAME via env → opkeep keychain. No `.env` files, no
   literal secrets in config, code, tests, or fixtures. Never log or store
   secret values, tunnel URLs, or recording plaintext.
7. Recordings stay AES-256-GCM encrypted at rest; audio bytes never cross
   MCP; deletion requires scope + confirmation. Exception (D-76): a `delegate`
   call's recording is held by ElevenLabs, never copied locally, and needs a
   third-party acknowledgement (`src/domain/consent.ts`).

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
- Reserved telephony ids parse but refuse construction: `twilio-media-streams`
  until implemented; `elevenlabs-managed` for good, pointing at the
  `agentPlatform` block (D-75 made it the delegate-mode agent platform —
  `src/adapters/agent-platform/elevenlabs.ts`). Delegate-mode code branches on
  `CALL_MODE_SPECS` predicates, never on the mode string.
- **Consult mode** (Phase R, `docs/plans/two-way-calling/PHASE-R-consult-mode.md`):
  a delegate call whose ElevenLabs agent has one webhook tool back to us. The
  question arrives as `consult.asked` on `get_call_events` and is answered with
  `answer_consult` (or `tel answer`). The per-call bearer is minted at dial
  time, handed to EL only as the `secret__consult_bearer` dynamic variable,
  stored only as a SHA-256 hash, and never logged. Tests run the whole loop
  against `FakeAgentPlatform` (`tests/consult-mode.test.ts`).
- **Group calls** (PHASE-GC, `docs/plans/two-way-calling/PHASE-GC-group-calls.md`):
  `start_meeting` (`tel meeting`) is a consult call with the meeting variant
  (D-104). One ElevenLabs ensemble agent, `eqstack-meeting`, chairs the call and
  speaks for each `meeting.members` entry in its saved voice. `ask_agent` is the
  consult route with an `agent` field (D-105, no new route). Members listen with
  `get_call_events {as, waitMs}`. The meeting body keeps `end_call` and
  `skip_turn` INSIDE `tools`. Tests: `tests/meeting-mode.test.ts`,
  `src/domain/meeting-brief.test.ts`.
- **Voice preview** (`tel voices …`, tools `preview_voices` /
  `review_voice_preview` / `save_voice_profile`): George auditions voices on
  ElevenLabs' hosted talk-to page, no phone call. `save_voice_profile` is the
  ONLY code that writes `config.json` (validated, atomic, backup kept); tests
  use temp files, never the live config. See
  `docs/plans/two-way-calling/VOICE-PREVIEW.md`.
- Narrow gate: `pnpm --filter telephony-mcp lint typecheck test`.
- Live/paid verification (tunnel install, smoke call, latency measurement) is
  gated on explicit authorization — see the ExecPlan.
