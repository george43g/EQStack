# voice-mcp

Local-first MCP server + telephony gateway: an MCP host (Claude Code, Codex,
any stdio client) places a real phone call to an **allowlisted** person and
holds a natural, interruptible conversation, with ElevenLabs voice over Twilio
ConversationRelay. The conversation is driven either by an OpenRouter LLM
(`llm` mode) or **directly by the MCP host itself** (`direct`, a.k.a.
"walkie-talkie" mode) — see [Conversation modes](#conversation-modes).

> New here or picking this up cold? Read [`HANDOFF.md`](./HANDOFF.md) first —
> current state, live-call proofs, the next feature (walkie-talkie
> thinking-sound loop), and the migration manifest.

```text
MCP host ── stdio ──► voice-mcp mcp ─┐ (mutations via localhost admin API)
                                     ▼
                voice-mcp serve  ◄── Twilio webhooks + ConversationRelay WS
                │        │            (public tunnel, signature-validated)
                │        └──► OpenRouter (streaming, abort on barge-in)
                ▼
   ~/Library/Application Support/voice-mcp
   (sqlite WAL: calls/events/transcripts/FTS · AES-256-GCM recordings)
```

## Entrypoints

| Command | Purpose |
| --- | --- |
| `voice-mcp mcp` | stdio MCP server (stderr-only logging) |
| `voice-mcp serve` | public Twilio listener + localhost-only admin/observability listener |
| `voice-mcp doctor` | config / state / secret-presence / gateway health checks (offline-safe) |
| `voice-mcp prepare <alias> --objective … [--mode llm\|direct]` | stage 1: expiring call request, nothing dialed |
| `voice-mcp call <requestId> --yes` | stage 2: dial (REAL, PAID call) |
| `voice-mcp say <callId> <text>` | speak text verbatim into a live call (direct-mode reply path) |
| `voice-mcp watch` | live SSE event tail |
| `voice-mcp history list\|show\|transcript\|search` | local call history (FTS5) |
| `voice-mcp recording play\|export\|delete` | encrypted recordings (local playback only) |

## Configuration

`~/.config/voice-mcp/config.json` (override `VOICE_MCP_CONFIG`), strictly
validated — see [`config.example.json`](./config.example.json). Highlights:

- `recipients`: the **allowlist**. Full E.164 numbers live ONLY here; every
  other surface (events, logs, MCP, search) sees alias + last four digits.
  Each recipient carries `recordingPolicy: preconsented | manual | never`.
- `profiles`: system prompt, model/fallback, voice overrides, duration,
  recording default. `default` profile is required.
- `llm`: OpenAI-compatible; OpenRouter by default. Ollama = `baseUrl:
  "http://localhost:11434/v1"`, a local model, `apiKeyRef: null`.
- `telephony.type`: `twilio-conversation-relay` (v1). `elevenlabs-managed`
  and `twilio-media-streams` are reserved ids — accepted by config, refused
  at construction.
- `server.publicBaseUrl`: the HTTPS tunnel origin; `serve` refuses to start
  without it. Only `/twilio/status`, `/twilio/recording`, and `/relay/<token>`
  are public, all X-Twilio-Signature-validated; admin/metrics/SSE bind
  127.0.0.1.

Secrets resolve by NAME at runtime (env → opkeep keychain cache): 
`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`,
`TWILIO_AUTH_TOKEN`, `OPENROUTER_API_KEY`. No `.env` files, no values in
config.

## Conversation modes

Chosen per call via `voice_prepare_call { mode }` (or `prepare --mode`):

- **`llm`** (default): the configured OpenRouter model conducts the call from
  the objective + system prompt. Sub-second warm turns.
- **`direct`** ("walkie-talkie mode"): the gateway runs **no** LLM loop — it
  records the callee's utterance (text inlined on the `turn.user` event) and
  waits. The **MCP host is the brain**: long-poll
  `voice_get_events { waitMs }` for the next `turn.user`, then reply verbatim
  with `voice_say`. A human talks directly to the agent; per-reply latency is
  a few seconds (one MCP round-trip + one model turn). In direct mode there is
  no system-prompted LLM mediating what is spoken — the two-stage dial gate,
  allowlist, redaction, and consent invariants still apply.

## Safety model

- **Two-stage dialing**: `voice_prepare_call` returns an expiring request;
  `voice_start_call` needs that id + `confirm: true` and is annotated
  paid/destructive/non-idempotent/open-world. Retries return the
  already-created call — never a second dial.
- **Consent**: `never` recipients cannot be recorded, ever. `manual`
  recipients start unrecorded; the disclosure line
  (`voice_play_disclosure`) and recording activation
  (`voice_set_recording`) are separate explicit tools and are never invoked
  automatically. `preconsented` records by default unless the request
  disables it.
- **Recordings**: downloaded dual-channel after the completed callback,
  encrypted AES-256-GCM with a macOS-Keychain-held key, retained until
  explicit deletion (`local | provider | both` + confirmation). Audio bytes
  never cross MCP; playback decrypts to a private temp file and removes it.
- **Boundary hardening**: every public HTTP/WS request signature-validated;
  replayed callbacks deduplicated by provider key; out-of-order status
  transitions dropped; unknown Call SIDs rejected.

## Development

```sh
pnpm --filter @george43g/voice-mcp test        # 98 tests, no network, no paid calls
pnpm --filter @george43g/voice-mcp typecheck
mise run voice-mcp:check                        # lint + typecheck + test
```

Tests cover: config strictness, consent matrix, redaction, request
expiry/idempotency, Twilio signatures, out-of-order/replayed callbacks, FTS
search, encryption round-trips, OpenRouter SSE contract (comment frames,
interruption, mid-stream errors, fallback), a full simulated WebSocket call,
direct-mode (no-LLM invariant, verbatim `voice_say`, `waitMs` long-poll,
say-refused-without-session), and the MCP tool surface over the SDK's
in-memory transport.

Live/paid smoke calls are a separately authorized step — see the ExecPlan
(`docs/exec-plans/active/2026-08-02-voice-mcp.md`) for the acceptance plan
(latency targets, barge-in stop, ConversationRelay eligibility).
