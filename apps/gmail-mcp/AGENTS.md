# gmail-mcp — Agent Guide

> This app lives at `apps/gmail-mcp` in the **EQStack monorepo** (migrated 2026-08-22 from the
> standalone `george43g/gmail-mcp` repo with full history). Repo-wide conventions — turbo tasks,
> serial-merge release discipline, per-package msr releases, root hooks — live in the **root
> `AGENTS.md`**; read both. This file covers the app itself.

> `CLAUDE.md` is a symlink to this file, so Claude Code and other coding agents can share the same repository conventions.

## What this repo is

Gmail integration exposed through 36 tools (read, search, send, draft lifecycle + `list_drafts`, reply-all, phishing-to-spam, labels, filters, threads, downloads, batch ops, send-as identities, cross-account unread summary, plus a `health_check` canary and the M2-light `list_accounts` / `switch_account` meta-tools). Two of the 36 — `delete_email` and `batch_delete_emails` — require the `gmail.full` scope, so an account without it sees a 34-tool catalog. Authenticates via OAuth2 against a personal Google project. **One binary** ships in this package — `gmail` — with mode subcommands:

| Subcommand | Purpose | Transport |
|---|---|---|
| `gmail mcp` | MCP server (default = stdio, `--http` enables Streamable HTTP) | stdio / HTTP |
| `gmail tui` | Ink/React multi-pane TUI with browse, search, accounts, labels, attachments, and compose | n/a |
| `gmail console` | Interactive REPL for ad-hoc Gmail operations | n/a (in-process calls) |
| `gmail account`, `gmail search`, … | Per-op CLI subcommands for humans + scripts | n/a (in-process calls) |

Bare `gmail` prints help; the CLI is the default surface.

- **Runtime**: Node.js ≥20.6 (uses native `--env-file`).
- **Module system**: ESM only (`type: "module"`).
- **Build**: clean `dist/`, then `tsc`. Run via `npm start` or `node dist/cli/index.js`.
- **Auth flow** (canonical): `gmail account auth [id] [--scopes=…] [--headless] [--print-json]`. Loads OAuth client keys from `GMAIL_OAUTH_KEYS_JSON` env or `~/.gmail-mcp/gcp-oauth.keys.json`, runs the loopback OAuth flow, writes credentials to `~/.gmail-mcp/accounts/<id>/credentials.json` (or prints them to stdout for env-driven deploys with `--print-json`). Bare `gmail account` opens the Inquirer account CRUD manager in a TTY. `gmail auth` is a deprecated stub that points users to `gmail account`.
- **Test runner**: vitest (`pnpm test` / `npm test`).
- **Quality scripts**: `pnpm lint` (biome), `pnpm typecheck` (`tsc --noEmit`), `pnpm format` (biome write), `pnpm verify` (lint+typecheck+test+clean build+e2e+usage+package+production audit).
- **Package manager**: **pnpm workspace only** (root `pnpm-lock.yaml`; the app's own lockfiles were dropped in the monorepo migration). Add a dep with `pnpm add <pkg>` in this directory; the root lockfile updates. npm/bunx consumers of the **published package** are unaffected. Note: `pnpm audit --prod` is workspace-wide — failures can root in any app; the blocking security gate for this package is the consumer-side `npm audit` in `gmail-ci.yml`'s package-smoke.

## Reference docs (moved out of this guide)

This guide keeps the rules; the reference detail lives in `docs/`. It was split on 2026-09-15 because
the root-to-app instruction chain was 55,448 bytes against Codex's `project_doc_max_bytes` of 32,768, so
a Codex session started in this directory silently lost everything past the cut — including the
post-step verification rule below. The repo-root `scripts/check-docs-integrity.mjs` now fails if any
chain exceeds the cap again.

| Doc | Contains |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | module layout and the robustness harness |
| [`docs/ENV_VARS.md`](docs/ENV_VARS.md) | the full environment-variable reference table |
| [`docs/MULTI_ACCOUNT.md`](docs/MULTI_ACCOUNT.md) | account layout and credential precedence |
| [`docs/HTTP_TRANSPORT.md`](docs/HTTP_TRANSPORT.md) | running the server over HTTP (Phase G) |
| [`docs/CLI.md`](docs/CLI.md) | every `gmail` subcommand, then the typed `--json` outputs (Phase B2) |
| [`docs/TESTING.md`](docs/TESTING.md) | the stress harness and the fixture-driven e2e tests |
| [`docs/KNOWN_FOLLOWUPS.md`](docs/KNOWN_FOLLOWUPS.md) | known follow-ups |

**Rules that live in those docs, lifted here verbatim so every tool still loads them:**

- **Robustness comes from `@george43g/robustness`** (npm; source: `github.com/george43g/mcp-cli-starter-template`, `packages/robustness/`). Do NOT re-grow a local `src/robustness/` — gaps or bugs in the package are work orders for the starter repo (its session confers with the other consumers and publishes fixes), not local forks.
**Env-driven mode is single-account by design.** `GMAIL_CREDENTIALS_JSON` / `GMAIL_CREDENTIALS_OP` always win over the file loader regardless of `accountId`. If you set them alongside `GMAIL_ACCOUNT`, the credentials still come from env; the account id is used only for the OAuth-keys override fallback and for log tagging. Pure-env multi-account would require per-account env vars (`GMAIL_CREDENTIALS_<ID>_JSON`) and is deferred to Phase M3.

## Branch workflow

`main` is the stable public branch. Use focused feature branches for changes, keep commits reviewable, and do not push generated local config or credentials. Before opening or merging a PR, run the verification commands relevant to the touched surface; for broad changes, run `pnpm verify`.

**Commit messages are Conventional Commits** (`feat(gmail-mcp): …`, `fix: …`, `chore: …`, …). multi-semantic-release derives per-package versions and changelogs from commits touching this app's path, so a malformed message on `main` silently produces no release. No commitlint hook in this repo — the convention is enforced socially and by msr semantics (root `AGENTS.md` owns hook policy). **Merges to `main` are strictly serial**: one PR → wait for its Release workflow run → next.

## Architecture

Moved to [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Robustness harness

Moved to [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## How `.mcp.json` env vars reach the server

- Claude Code (and most MCP hosts) **merge** the `env` block from `.mcp.json` into the inherited host environment — they do not replace it.
- Variable expansion: `${HOME}`, `${VAR:-default}` work in `command`, `args`, `env`, etc.
- The host does **not** run your shell init (`~/.zshrc`, `~/.bashrc`). Variables exported there are unavailable to the spawned MCP unless you pass them through the `env` block or via `.env` files (see below).
- `.env` is **not** automatic — Node 20.6+ needs `--env-file`. `package.json` scripts do this; the dev MCP proxy does too.

## Env file precedence

`package.json`'s `start` and `auth` scripts pass `--env-file-if-exists=.env --env-file-if-exists=.env.local`. Both files are gitignored. `.env.local` overrides `.env`.

`.env.example` documents every recognised variable. Copy it to `.env.local` for local overrides.

## Env-var reference

Moved to [`docs/ENV_VARS.md`](docs/ENV_VARS.md).

## Auth scope selection

`gmail account auth` resolves OAuth scopes via this precedence (first match wins, implemented in `src/auth-scopes.ts`):

1. **`--scopes=foo,bar`** CLI flag (comma- or space-separated shorthand names).
2. **`GMAIL_SCOPES` env var** — same syntax as the flag. `pnpm run dev -- account auth <id>` / `npm run dev -- account auth <id>` auto-load `.env` and `.env.local`, so this is the easiest knob for repeat use.
3. **Interactive checkbox prompt** (`@inquirer/prompts` `checkbox`) — TTY only. Defaults are pre-checked; space toggles, `a` selects all, `i` inverts, enter confirms.
4. **Defaults** (`gmail.modify`, `gmail.settings.basic`) — used when `--non-interactive` is passed, `CI=true`, `GMAIL_AUTH_NON_INTERACTIVE=1`, or stdin is not a TTY.

Granted scopes are persisted into `~/.gmail-mcp/accounts/<id>/credentials.json` as `{ tokens, scopes }`. Runtime tool filtering (`hasScope` in `src/scopes.ts`) uses that list to:
- Hide out-of-scope tools from the `tools/list` response.
- Reject `tools/call` for an out-of-scope tool with a clear error suggesting re-auth.

**Scopes are not "conflicting" — they're hierarchical.** `gmail.modify` supersedes `gmail.readonly` and `gmail.labels`; `gmail.compose` supersedes `gmail.send`. Picking a broader scope plus a narrower one isn't an error; it just makes the consent screen verbose. `health_check` requires no scope (`scopes: []` in `src/tools.ts`).

## Credential loader chain

OAuth keys (the Google Cloud Console JSON) and access tokens are loaded from independent sources, each with its own loader chain (first hit wins). Implementations in `src/core/auth-flow.ts` and `src/core/credentials.ts`.

**OAuth client keys** (`loadOAuthKeys`):
1. `GMAIL_OAUTH_KEYS_JSON` env — full JSON inline.
2. File at `GMAIL_OAUTH_PATH` (default `<configDir>/gcp-oauth.keys.json`). Honors the legacy "drop `gcp-oauth.keys.json` in cwd and we copy it" convenience.
3. Error with hint to set the env var or place the file.

**Access/refresh tokens** (`loadCredentials`):
1. `GMAIL_CREDENTIALS_JSON` env — full `{tokens, scopes}` JSON.
2. `GMAIL_CREDENTIALS_OP` env — 1Password reference (`op://Vault/Item/field`); shells out to `op read`.
3. File at `GMAIL_CREDENTIALS_PATH` (default `<configDir>/credentials.json`).
4. Error with hint to run `gmail account auth <id>`.

Together, env-inline keys + env-inline credentials let a deployment run with **zero filesystem state** — useful for Docker, Cloud Run, MCP hosts whose CWD/`.env` we don't control. Capture both in one shot:

```sh
gmail account auth deploy --print-json > deploy.env.json
# emits {GMAIL_OAUTH_KEYS_JSON: "...", GMAIL_CREDENTIALS_JSON: "..."}
```

Pipe that into a host's `.mcp.json` `env: {}` block, GH Actions repo secret, 1Password item, etc.

## Multi-account layout

Moved to [`docs/MULTI_ACCOUNT.md`](docs/MULTI_ACCOUNT.md).

## HTTP transport mode (Phase G)

Moved to [`docs/HTTP_TRANSPORT.md`](docs/HTTP_TRANSPORT.md).

## gmail subcommand catalogue

Moved to [`docs/CLI.md`](docs/CLI.md).

## Typed structured outputs (Phase B2)

Moved to [`docs/CLI.md`](docs/CLI.md).

## MCP best practices enforced in this codebase

1. **Never write to stdout after the StdioServerTransport opens** — the JSON-RPC stream lives on stdout. All logs go through `logger.ts` (NDJSON file + ring buffer; no console). Existing `console.log` calls in the auth flow are safe because they run before the transport opens.
2. **Every tool runs through `withTimeout`** — `src/index.ts` wraps the dispatcher body. New tools must declare a budget in `TOOL_TIMEOUTS_MS` (or rely on `DEFAULT_TOOL_TIMEOUT_MS`). Set to `0` to opt out only when you have a specific reason.
3. **Honor `AbortSignal`** — long-running loops (e.g. `processBatches`) check `signal?.aborted` between iterations and bail with a logged record.
4. **Auth errors get a remediation hint** — wrap with `wrapToolError` (in `src/auth-errors.ts`). Bare `invalid_grant` is never returned — always include the tool name and a `gmail account auth <id>` pointer.
5. **No new robustness knobs without an `MCP_*` env override** — go through `@george43g/robustness`'s `envNum`/`envBool`/`envStr` (fallback argument is required).
6. **`health_check` never touches Gmail** — it's the canary that must answer instantly even when the network is down.

## Post-step verification rule (REQUIRED for all changes)

After every change to this repo:

1. **Rebuild**: `npm run build`.
2. **Add a regression test** when the change is unit-testable. Vitest tests live next to the source (`*.test.ts`). (The robustness harness's unit coverage lives upstream in `mcp-cli-starter-template`; here, cover its wiring via the stress harness.)
3. **Regenerate/check CLI usage artifacts when Commander commands or help text change**: `pnpm run gen-usage`, then `pnpm run gen-usage -- --check`. `usage.kdl` is the source for completions and manpages.
4. **Run the full test suite**: `npm test`.
5. **Run the stress harness on changes that touch the dispatcher / lifecycle**: `npm run stress`.
6. **Run the e2e suite when touching bootstrap / account / dispatch surfaces**: `pnpm test:e2e`. Boots the dispatcher against `fixtures/gmail/{work,personal,full}/` and exercises `list_inbox_threads → switch_account → list_inbox_threads`, the full 36-tool `gmail.full` catalog (attachment download, HTML read, deep thread, permanent delete, `list_drafts` + draft edit→send round-trip), + the CLI binary. `pnpm verify` runs it automatically.

For release or publish-prep changes, also run `npm pack --dry-run` and inspect the tarball file list.

## PR & issue review

Prioritize build breakage, behavior regressions, missing tests, credential leakage, network exposure, and dependency/supply-chain risk. This is a local stdio MCP server by default, so review security findings against that threat model rather than treating every local filesystem operation as remote-code risk.

## Stress harness

Moved to [`docs/TESTING.md`](docs/TESTING.md).

## Fixture-driven e2e tests

Moved to [`docs/TESTING.md`](docs/TESTING.md).

## Known follow-ups

Moved to [`docs/KNOWN_FOLLOWUPS.md`](docs/KNOWN_FOLLOWUPS.md).

## MCP servers (project scope)

MCP host config is a **monorepo-root concern** — the app-level `.mcp.json`
symlink, `opencode.json`, and `.warp` config were dropped in the migration
(the app's canonical `.mcp.json` was gitignored/machine-specific and does not
exist here). To register a gmail dev server for local hosts, add it to the
ROOT config per the root `AGENTS.md` conventions. Two standing rules survive
the move: never put literal secrets in host config (`${VAR}` placeholders
only), and dev MCP servers must spawn via `node --import tsx …`, NEVER the
`.bin/tsx` CLI wrapper (it SIGKILLs busy children ~30ms after a relayed
signal; imsg's repo-wide `tsx-spawn-inventory` guard test enforces this for
all tracked code/config).
