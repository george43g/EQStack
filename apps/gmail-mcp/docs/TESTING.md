# Stress harness and e2e tests — gmail-mcp

> Moved out of `apps/gmail-mcp/AGENTS.md` on 2026-09-15 so that guide fits Codex's instruction cap
> (`project_doc_max_bytes`, 32,768 bytes across the root-to-app chain). Content is unchanged except that
> relative link targets gained `../`. The guide keeps the must-hold rules and links here.

## Stress harness

`scripts/stress-mcp.ts` (run via `pnpm run stress` / `npm run stress`) covers ten cases:

- handshake + tools/list returns the full catalog
- `health_check` returns `Status: healthy`
- 20 parallel `health_check` calls all stay healthy
- unknown tool name is rejected
- malformed schema input returns a usable error
- `MCP_TOOL_TIMEOUT_FORCE_MS=1` triggers a clean timeout
- **MCP self-heals: serves the next call after a timed-out one** (per-tool timeout doesn't kill the server)
- SIGTERM produces exit code 0 (handler intercepted, not signal default)
- `MCP_MAX_RSS_MB=50` triggers a watchdog kill **and records `watchdog_kill: rss_exceeded` in NDJSON** (post-mortem grep contract)
- HTTP transport: `/health` returns 200, `/mcp` without bearer token returns 401, full `initialize → notifications/initialized → tools/list` round-trip with bearer + session-id returns the full catalog

Add a case here when you ship anything that changes lifecycle, dispatch, error handling, or transport.

## Fixture-driven e2e tests

`tests/e2e/` runs the full bootstrap → dispatcher pipeline against `fixtures/gmail/{work,personal,full}/` instead of real Gmail. Toggled by `GMAIL_FIXTURE_MODE=1` (set automatically by the e2e setup; also available via `node --env-file=.env.test`).

The three committed accounts cover the scope tiers: `work` (`gmail.modify` + `gmail.settings.basic` → 34-tool catalog), `personal` (`gmail.readonly`), and `full` (`gmail.full` + `gmail.settings.basic` → the complete **36-tool** catalog, including `delete_email` / `batch_delete_emails`). The `full` account carries the richer corpus: an HTML `multipart/alternative` body, a `multipart/mixed` message with a real attachment part, a deep 5-message thread, DRAFT/SENT/SPAM-labelled messages, and a `drafts/` corpus (`list_drafts` + the draft edit→update→send round-trip).

Layout:
- `fixtures/gmail/<accountId>/` — per-account JSON corpus: `profile.json`, `scopes.json`, `labels.json`, `filters.json`, `messages/<id>.json`, `threads/<id>.json`, plus optional `drafts/<id>.json`, `attachments/<msgId>-<attId>.json`, and `sendas.json` / `forwarding.json`.
- `src/fixtures/gmail-schemas.ts` — Zod mirrors of `gmail_v1.Schema$X` shapes. Every fixture is `.parse()`'d before being returned by the fake gmail client; a schema mismatch surfaces immediately.
- `src/fixtures/gmail-fixture-client.ts` — implements the `gmail.users.*` methods the ops call (getProfile, messages.*, messages.attachments.get, threads.*, drafts.{list,get,create,update,send,delete}, labels.*, settings.*). Read paths return validated fixture data; mutating paths return canned success.
- `src/fixtures/schemas.test.ts` — runs in the unit suite. Validates every committed fixture (messages, threads, drafts, attachments) under Zod **and** runs a no-real-data guard (denylist: `george.g93`, `@anthropic.com`). CI fails if a fixture leaks real data.

Adding new fixtures: hand-craft JSON under `fixtures/gmail/<account>/`, run `pnpm test` to confirm Zod validation, then `pnpm test:e2e` to confirm the dispatcher serves them. Synthetic email addresses use the `@fixture.test` TLD by convention.

Optional capture+anonymise scripts (`scripts/capture-fixtures.ts`, `scripts/anonymise-fixtures.ts`) are not yet shipped — the hand-crafted corpus suffices today. Open them as a follow-up when growing the corpus from real Gmail.
