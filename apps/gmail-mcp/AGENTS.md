# Gmail-MCP-Server — Agent Guide

> `CLAUDE.md` is a symlink to this file — both Claude Code and other coding agents read these conventions.

## What this repo is

Gmail integration exposed through 27 tools (read, search, send, draft, reply-all, labels, filters, threads, downloads, batch ops, plus a `health_check` canary). Authenticates via OAuth2 against a personal Google project. **One binary** ships in this package — `gmail` — with mode subcommands:

| Subcommand | Purpose | Transport |
|---|---|---|
| `gmail mcp` | MCP server (default = stdio, `--http` enables Streamable HTTP) | stdio / HTTP |
| `gmail tui` | Ink/React multi-pane TUI (Phase D — currently a stub) | n/a |
| `gmail console` | Interactive REPL for ad-hoc Gmail operations | n/a (in-process calls) |
| `gmail auth`, `gmail search`, … | Per-op CLI subcommands for humans + scripts | n/a (in-process calls) |

Bare `gmail` prints help; the CLI is the default surface.

- **Runtime**: Node.js ≥20.6 (uses native `--env-file`).
- **Module system**: ESM only (`type: "module"`).
- **Build**: `tsc` → `dist/`. Run via `npm start` or `node dist/cli/index.js`.
- **Auth flow** (canonical): `gmail auth [--scopes=…] [--headless] [--print-json]`. Loads OAuth client keys from `GMAIL_OAUTH_KEYS_JSON` env or `~/.gmail-mcp/gcp-oauth.keys.json`, runs the loopback OAuth flow, writes credentials to `~/.gmail-mcp/credentials.json` (or prints them to stdout for env-driven deploys with `--print-json`). See [Auth scope selection](#auth-scope-selection) and [Credential loader chain](#credential-loader-chain).
- **Test runner**: vitest (`pnpm test` / `npm test`).
- **Quality scripts**: `pnpm lint` (biome), `pnpm typecheck` (`tsc --noEmit`), `pnpm format` (biome write), `pnpm verify` (lint+typecheck+test+build).
- **Package manager**: both `npm` and `pnpm` are supported. `pnpm-lock.yaml` and `package-lock.json` both live in the repo. Locally, `pnpm` is preferred. **When adding a dep, run `pnpm add <pkg>` followed by `npm install --package-lock-only` to keep both lockfiles in sync without disturbing pnpm's `node_modules` layout.** CI/published-package consumers using `npm` or `bunx` are unaffected.

## Branch workflow

Two-branch model. `main` is stable, `experimental` is staging. Full SOP in `.claude/skills/pr-review-sop/SKILL.md` — required reading for any PR work.

## Architecture

```
src/
├── index.ts              # Thin orchestrator (~240 lines): bootstrap → buildMcpServer → transport
├── tools.ts              # Zod schemas + tool registry (single source of truth for metadata)
├── scopes.ts             # OAuth scope <-> URL mapping; hasScope() check
├── auth-scopes.ts        # Scope resolver: --scopes flag / GMAIL_SCOPES env / interactive checkbox
├── auth-errors.ts        # OAuth error wrapping + remediation hints
├── safe-path.ts          # Path-traversal guard for downloads
├── label-manager.ts      # Low-level Gmail labels API helpers (wraps gmail.users.labels.*)
├── filter-manager.ts     # Low-level Gmail filters API helpers
├── reply-all-helpers.ts  # RFC5322 parsing + recipient list builders
├── email-export.ts       # Email → JSON / EML / TXT / HTML formatters
├── utl.ts                # Email construction (raw + nodemailer paths)
│
├── core/                 # Surface-agnostic core (used by stdio MCP, HTTP MCP, CLI, future TUI)
│   ├── credentials.ts    # Credential loader chain: env JSON → 1Password CLI → file
│   ├── auth-flow.ts      # OAuth keys loader (env or disk), createOAuthClient, runOAuthFlow
│   ├── config-paths.ts   # getConfigDir / getOAuthPath / getCredentialsPath (env-overridable)
│   ├── session.ts        # Process session state: oauth2Client / gmail / authorizedScopes / counters
│   ├── context.ts        # OperationContext type + createContext() factory
│   ├── registry.ts       # OperationRegistry — name → {schema, handler, scopes}; dispatch()
│   ├── email-helpers.ts  # extractEmailContent / extractHeaders / extractAttachments (pure)
│   ├── batch.ts          # processBatches helper (signal-aware, per-item fallback)
│   └── ops/              # Per-category tool handlers — registry-registered at module load
│       ├── index.ts      # Barrel: imports each op file for side-effect registration
│       ├── health.ts     # health_check (no Gmail call)
│       ├── messages.ts   # read_email, search_emails, modify_email, delete_email
│       ├── threads.ts    # get_thread, list_inbox_threads, get_inbox_with_threads, modify_thread
│       ├── labels.ts     # list_email_labels + create/update/delete/get_or_create_label
│       ├── send.ts       # send_email, reply_all + shared handleEmailAction helper
│       ├── drafts.ts     # draft_email (delegates to handleEmailAction)
│       ├── batch-ops.ts  # batch_modify_emails, batch_delete_emails
│       ├── filters.ts    # list/get/create/delete/template filter ops
│       └── downloads.ts  # download_email, download_attachment
│
├── server/               # Transport + Server construction
│   ├── build.ts          # buildMcpServer(): { server, dispatch } — owns TOOL_TIMEOUTS_MS,
│   │                     #   wires CallToolRequestSchema → registry.dispatch with auth-error
│   │                     #   wrapping + per-tool withTimeout + scope gating
│   └── http.ts           # Streamable HTTP transport + bearer-token auth + /health endpoint
│
├── cli/                  # `gmail` bin (commander) — full parity with the MCP catalog
│   ├── index.ts          # bin entry; buildProgram() factory + main(); wires all subcommands
│   ├── runtime.ts        # bootstrapForCli + runCliOp + printToolResult + helpers
│   └── commands/
│       ├── mcp.ts        # gmail mcp [--http]: run the MCP server (stdio default)
│       ├── tui.ts        # gmail tui: lazy-loads src/tui/index.ts::runTui (Phase D)
│       ├── auth.ts       # auth: scope resolution + OAuth flow + (--print-json env capture)
│       ├── health.ts     # health: local canary, --json returns typed HealthSnapshot
│       ├── search.ts     # search <query>
│       ├── read.ts       # read <messageId>
│       ├── threads.ts    # threads {list, get, modify, inbox} + top-level inbox alias
│       ├── send.ts       # send, draft, reply-all (shared body resolution; @file / stdin / literal)
│       ├── messages.ts   # modify, delete (per-message)
│       ├── batch.ts      # batch-modify, batch-delete (--ids comma | @file)
│       ├── labels.ts     # labels {list, create, update, delete, get-or-create}
│       ├── filters.ts    # filters {list, get, create, delete, template}
│       └── downloads.ts  # download-email, download-attachment
│
└── robustness/           # Reusable robustness library — surface-agnostic
    ├── env.ts            # envNum / envBool / envStr helpers
    ├── shutdown.ts       # Cleanup registry + signal handlers + EOF/orphan
    ├── logger.ts         # NDJSON file + 500-line ring buffer + perf spans
    ├── watchdog.ts       # Event-loop / memory / idle monitors
    ├── with-timeout.ts   # Per-tool Promise.race timeout wrapper
    ├── health.ts         # health_check formatter
    ├── retry.ts          # Exponential backoff for transient Gmail errors
    ├── rate-limit.ts     # Token-bucket limiter
    └── index.ts          # Barrel
```

### Module boundary rules

- **`src/robustness/`** — must NOT import Gmail / Google libraries. Library-eligible drop-in code for any local MCP server.
- **`src/core/credentials.ts`, `src/core/config-paths.ts`, `src/core/session.ts` (no runtime imports), `src/core/registry.ts`, `src/core/context.ts`, `src/core/batch.ts`, `src/core/email-helpers.ts`** — Gmail-agnostic shape handling. No `googleapis` / `google-auth-library` imports.
- **`src/core/auth-flow.ts`** — imports `google-auth-library` because OAuth-via-Google is intrinsic.
- **`src/core/ops/*.ts`** — uses `ctx.gmail` from OperationContext to make Gmail API calls. No top-level `googleapis` imports needed; the typed handle comes via the context.
- **`src/server/*.ts`** — wires the MCP SDK Server to the registry. Consumes `core/session` to read OAuth state.
- **`src/cli/*.ts`** — CLI surface (the `gmail` bin). Calls `callMcpTool` from `src/index.ts` for tool dispatch; `auth` runs the OAuth flow directly; `mcp` calls `main()` to start the server.
- **`src/index.ts`** — MCP orchestrator (bootstrap → `buildMcpServer` → transport). No longer a bin entry; only imported by the `mcp` subcommand and the CLI runtime.

### How a tool call flows

```
host → stdio JSON-RPC → StdioServerTransport
                          ↓
              server/build.ts dispatch(name, args, signal)
                          ↓
        scope gate → withTimeout(name, fn, ms) →
                          ↓
              registry.dispatch(name, args, ctx)
                          ↓
        schema.parse(args) → handler(input, ctx)
                          ↓
              ctx.gmail.users.* → Gmail API
                          ↓
              OperationResult { content, isError? }
```

Auth errors throw inside the handler; `wrapToolError` (in `auth-errors.ts`) catches at the dispatch boundary and returns the MCP error response. Timeouts throw `ToolTimeoutError`; the dispatcher converts to an `isError: true` MCP response with a clear message.

## Robustness harness

The `src/robustness/` modules form a "robustness harness" that any local stdio MCP server can lift wholesale.

| Module | What it does |
|---|---|
| `shutdown.ts` | Cleanup registry. Traps SIGINT/SIGTERM/SIGHUP/SIGQUIT, stdin EOF (host died), parent-PID watchdog (orphan reparent). 3s safety force-exit. |
| `logger.ts` | Structured logs to `MCP_LOG_DIR/gmail-mcp-<pid>-<ts>.ndjson` + in-memory 500-line ring. `info/warn/error/perf` levels. `logStartup`/`logShutdown` markers — file without a `shutdown` entry indicates a crash. |
| `watchdog.ts` | Three monitors. Event-loop p99 lag → kill at 10s default. RSS cap or sustained heap growth → kill. 24h uptime + 1h idle → graceful restart. All env-tunable. |
| `with-timeout.ts` | `Promise.race` per dispatch with `ToolTimeoutError`. Per-tool map + global default. |
| `health.ts` | Pure formatter — never touches Gmail. Reads watchdog state + caller-supplied counters → `Status: healthy/degraded/unhealthy` text. |
| `env.ts` | Validated env-var helpers. All robustness knobs use `MCP_*` prefix. |

## How `.mcp.json` env vars reach the server

- Claude Code (and most MCP hosts) **merge** the `env` block from `.mcp.json` into the inherited host environment — they do not replace it.
- Variable expansion: `${HOME}`, `${VAR:-default}` work in `command`, `args`, `env`, etc.
- The host does **not** run your shell init (`~/.zshrc`, `~/.bashrc`). Variables exported there are unavailable to the spawned MCP unless you pass them through the `env` block or via `.env` files (see below).
- `.env` is **not** automatic — Node 20.6+ needs `--env-file`. `package.json` scripts do this; the dev MCP proxy does too.

## Env file precedence

`package.json`'s `start` and `auth` scripts pass `--env-file-if-exists=.env --env-file-if-exists=.env.local`. Both files are gitignored. `.env.local` overrides `.env`.

`.env.example` documents every recognised variable. Copy it to `.env.local` for local overrides.

## Env-var reference

### Gmail-specific (`GMAIL_*`)
| Name | Default | Purpose |
|---|---|---|
| `GMAIL_CONFIG_DIR` | `~/.gmail-mcp/` | Override the config directory. Useful in Docker (mount a volume) or for shared deployments. Affects defaults of `GMAIL_OAUTH_PATH` and `GMAIL_CREDENTIALS_PATH` only. |
| `GMAIL_OAUTH_PATH` | `<configDir>/gcp-oauth.keys.json` | OAuth client keys file path (file fallback when env-inline isn't set). |
| `GMAIL_OAUTH_KEYS_JSON` | unset | **Inline OAuth client keys** — JSON string of `{installed:{client_id,client_secret}}` (or `{web:{...}}`, or bare `{client_id,client_secret}`). Wins over file. Lets a deployment run with no filesystem state. |
| `GMAIL_CREDENTIALS_PATH` | `<configDir>/credentials.json` | Stored access/refresh tokens file path (fallback). |
| `GMAIL_CREDENTIALS_JSON` | unset | **Inline credentials** — JSON of `{tokens, scopes}`. Wins over 1Password and file. Designed for GH Actions secrets, Docker, k8s. |
| `GMAIL_CREDENTIALS_OP` | unset | 1Password secret reference (`op://Vault/Item/field`). Shells out to `op read`. Wins over file. |
| `GMAIL_SCOPES` | unset | Default scope set used by `gmail auth` when `--scopes=` is not passed. Comma- or space-separated shorthand names. |
| `GMAIL_AUTH_NON_INTERACTIVE` | unset | `1` forces non-interactive auth (skip the checkbox prompt, fall back to defaults). Auto-detected when `CI=true` or stdin is not a TTY. |
| `GMAIL_HTTP_TOKEN` | unset (required for `--http`) | Bearer token gating `/mcp` requests in HTTP mode. Server refuses to start if `--http` is set but this is empty. Generate with `openssl rand -hex 32`. |

### Robustness (`MCP_*`) — library knobs
| Name | Default | Purpose |
|---|---|---|
| `MCP_LOG_DIR` | `$TMPDIR/gmail-mcp/` | Where NDJSON logs are written |
| `MCP_LOG_MAX_BYTES` | `10485760` | File rotation threshold (10 MB) |
| `MCP_LOG_RING_SIZE` | `500` | In-memory ring buffer size |
| `MCP_HEAP_WARN_MB` | `150` | Warn-level threshold for heap heartbeat |
| `MCP_HEAP_CHECK_MS` | `60000` | Heartbeat interval |
| `MCP_EVENT_LOOP_SAMPLE_MS` | `5000` | Event-loop p99 sample window |
| `MCP_EVENT_LOOP_WARN_MS` | `500` | Warn threshold |
| `MCP_EVENT_LOOP_KILL_MS` | `10000` | Kill threshold |
| `MCP_MEMORY_SAMPLE_MS` | `60000` | Memory monitor tick |
| `MCP_MAX_RSS_MB` | `1024` | RSS hard cap (kill above this) |
| `MCP_HEAP_GROWTH_SAMPLES` | `10` | Consecutive monotonic-growth samples → leak kill |
| `MCP_RESTART_AFTER_MS` | `86400000` | Min uptime before idle-restart eligible (24h) |
| `MCP_RESTART_QUIET_MS` | `3600000` | Min idle period before restart (1h) |
| `MCP_IDLE_CHECK_MS` | `600000` | Idle monitor tick (10min) |
| `MCP_TOOL_TIMEOUT_DEFAULT_MS` | `30000` | Default per-tool timeout |
| `MCP_TOOL_TIMEOUT_FORCE_MS` | unset | If `>0`, forces this timeout for every tool — testing/incident knob |

## Auth scope selection

`gmail auth` resolves OAuth scopes via this precedence (first match wins, implemented in `src/auth-scopes.ts`):

1. **`--scopes=foo,bar`** CLI flag (comma- or space-separated shorthand names).
2. **`GMAIL_SCOPES` env var** — same syntax as the flag. `pnpm run auth` / `npm run auth` auto-load `.env` and `.env.local`, so this is the easiest knob for repeat use.
3. **Interactive checkbox prompt** (`@inquirer/prompts` `checkbox`) — TTY only. Defaults are pre-checked; space toggles, `a` selects all, `i` inverts, enter confirms.
4. **Defaults** (`gmail.modify`, `gmail.settings.basic`) — used when `--non-interactive` is passed, `CI=true`, `GMAIL_AUTH_NON_INTERACTIVE=1`, or stdin is not a TTY.

Granted scopes are persisted into `~/.gmail-mcp/credentials.json` as `{ tokens, scopes }`. Runtime tool filtering (`hasScope` in `src/scopes.ts`) uses that list to:
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
4. Error with hint to run `gmail auth`.

Together, env-inline keys + env-inline credentials let a deployment run with **zero filesystem state** — useful for Docker, Cloud Run, MCP hosts whose CWD/`.env` we don't control. Capture both in one shot:

```sh
gmail auth --print-json > deploy.env.json
# emits {GMAIL_OAUTH_KEYS_JSON: "...", GMAIL_CREDENTIALS_JSON: "..."}
```

Pipe that into a host's `.mcp.json` `env: {}` block, GH Actions repo secret, 1Password item, etc.

## HTTP transport mode (Phase G)

`gmail mcp --http [--port 8080] [--bind 127.0.0.1] [--token-env GMAIL_HTTP_TOKEN]` exposes the MCP via `StreamableHTTPServerTransport` instead of stdio. Single-tenant: one server process = one Gmail account.

- **Endpoints**: `POST /mcp` (MCP protocol; bearer-token required) + `GET /health` (open; for reverse-proxy probes; returns 503 if `unhealthy`).
- **Auth**: `Authorization: Bearer <token>` checked against `process.env[GMAIL_HTTP_TOKEN]` (constant-time compare). Server refuses to start if the env is unset.
- **Sessions**: stateful — server hands out a `mcp-session-id` header on `initialize`; clients echo it on subsequent requests. Required for the MCP handshake to share state.
- **TLS**: out of scope. Bind defaults to `127.0.0.1` so a reverse-proxy (Caddy / nginx / Cloudflare Tunnel / Cloud Run) is the only ingress path. Set `--bind 0.0.0.0` only if you trust the network.
- **Reuses the dispatcher**: same `Server` instance, same OAuth/credentials/retry/rate-limit pipeline, same per-tool timeouts. Only the transport swaps.

Connect any MCP host:
- Claude Code: `claude mcp add --transport http --url https://gmail.example.com/mcp --header "Authorization: Bearer $TOKEN" gmail-remote`
- OpenCode: `opencode.json` → `{ type: "remote", url, headers: { Authorization: "Bearer ${GMAIL_HTTP_TOKEN}" } }`
- Cursor / Warp: stdio-only currently — proxy locally with a thin stub if needed (deferred to Phase G2).

## gmail subcommand catalogue

Every Gmail tool has a corresponding `gmail` CLI subcommand. All commands accept `--json` (emits the typed `OperationResult.structuredContent` payload — see B2 below) and exit with `0` on success, `1` general error, `2` auth error (credentials missing / `invalid_grant`), `3` schema / usage error.

| Subcommand | Tool | Notes |
|---|---|---|
| `auth` | (OAuth flow) | Browser-based; `--headless` for remote servers; `--print-json` to capture creds + keys for env-driven deploys |
| `health` | `health_check` | No Gmail call; local canary. `--json` returns typed `HealthSnapshot` |
| `inbox` | `list_inbox_threads` | Shortcut for `threads list -q in:inbox` |
| `search <query>` | `search_emails` | `--max N`. `--json` returns `{resultCount, results[]}` |
| `read <messageId>` | `read_email` | `--json` returns full message body + attachments metadata |
| `threads list` | `list_inbox_threads` | `--query`, `--max` |
| `threads get <id>` | `get_thread` | `--format full|metadata|minimal` |
| `threads modify <id>` | `modify_thread` | `--add ids`, `--remove ids` |
| `threads inbox` | `get_inbox_with_threads` | `--expand` to fetch full message content per thread |
| `send` | `send_email` | `-t`, `-s`, `-b` (literal / `'-'` for stdin / `'@file'`), `--cc`, `--bcc`, `--attach` (repeatable), `--thread-id`, `--in-reply-to`, `--from` (send-as alias), `--mime-type` |
| `draft` | `draft_email` | Same flags as `send`; creates draft instead of sending |
| `reply-all <messageId>` | `reply_all` | Auto-builds To/CC and threading headers from the original; `-b` body required |
| `modify <messageId>` | `modify_email` | `--add ids`, `--remove ids` |
| `delete <messageId>` | `delete_email` | Permanent (irreversible) |
| `batch-modify` | `batch_modify_emails` | `--ids` comma-separated or `@file.txt`; `--add`, `--remove`, `--batch-size`; max 500 |
| `batch-delete` | `batch_delete_emails` | `--ids` same syntax; `--batch-size`; max 500 |
| `labels list` | `list_email_labels` | |
| `labels create <name>` | `create_label` | `--show`, `--label-list` |
| `labels update <id>` | `update_label` | `--name`, `--show`/`--hide`, `--label-list` |
| `labels delete <id>` | `delete_label` | |
| `labels get-or-create <name>` | `get_or_create_label` | Idempotent |
| `filters list` | `list_filters` | |
| `filters get <id>` | `get_filter` | |
| `filters create` | `create_filter` | `--from`, `--to`, `--subject`, `--query`, `--has-attachment`, `--add-label`, `--remove-label`, `--forward` |
| `filters delete <id>` | `delete_filter` | |
| `filters template <name>` | `create_filter_from_template` | Templates: `fromSender`, `withSubject`, `withAttachments`, `largeEmails`, `containingText`, `mailingList` |
| `download-email <id>` | `download_email` | `-o save-dir`, `-f json|eml|txt|html` |
| `download-attachment <id> <attId>` | `download_attachment` | `-o save-dir`, `--filename` |
| `mcp [--http]` | (transport) | Starts the MCP server; `--http` + `--port`, `--bind`, `--token-env` for Streamable HTTP mode |
| `tui` | — | Multi-pane Ink/React TUI (Phase D; currently a stub) |
| `console` | — | Interactive REPL (planned in Step 2 of the bin-consolidation work) |

CLI commands are thin wrappers over `callMcpTool(name, args)` (in-process; no child-process spawn). The common boilerplate is `runCliOp(toolName, args, {json}) -> Promise<never>` in `src/cli/runtime.ts`.

## Typed structured outputs (Phase B2)

Every registered op declares an `outputSchema` (a zod schema in `src/tools.ts`) and populates `OperationResult.structuredContent: z.infer<typeof outputSchema>` on its return. The MCP wire protocol still ships the legacy `content: [{type:"text", text:"..."}]` envelope unchanged; the typed JSON rides alongside.

Three consumers benefit:
- **`gmail … --json`** — emits the typed structured payload directly. `gmail search "in:inbox" --json` returns `{resultCount, results: [{id, subject, from, date}, ...]}` ready for `jq`, not the wrapped text envelope.
- **TUI hooks (Phase D)** — bind to typed `result.structuredContent` fields without parsing text.
- **MCP hosts that respect `outputSchema`** — get type info per tool, can validate responses.

Op handlers without an `outputSchema` stay text-only (no breakage; just no `--json` benefit). To opt a new op in: add a `*OutputSchema` to `src/tools.ts`, set `outputSchema` on the registry entry, and populate `structuredContent` on the return.

## MCP best practices enforced in this codebase

1. **Never write to stdout after the StdioServerTransport opens** — the JSON-RPC stream lives on stdout. All logs go through `logger.ts` (NDJSON file + ring buffer; no console). Existing `console.log` calls in the auth flow are safe because they run before the transport opens.
2. **Every tool runs through `withTimeout`** — `src/index.ts` wraps the dispatcher body. New tools must declare a budget in `TOOL_TIMEOUTS_MS` (or rely on `DEFAULT_TOOL_TIMEOUT_MS`). Set to `0` to opt out only when you have a specific reason.
3. **Honor `AbortSignal`** — long-running loops (e.g. `processBatches`) check `signal?.aborted` between iterations and bail with a logged record.
4. **Auth errors get a remediation hint** — wrap with `wrapToolError` (in `src/auth-errors.ts`). Bare `invalid_grant` is never returned — always include the tool name and `npm run auth` pointer.
5. **No new robustness knobs without an `MCP_*` env override** — go through `src/robustness/env.ts`.
6. **`health_check` never touches Gmail** — it's the canary that must answer instantly even when the network is down.

## Post-step verification rule (REQUIRED for all changes)

After every change to this repo:

1. **Rebuild**: `npm run build`.
2. **Reload the dev MCP**: the proxy (`scripts/mcp-dev-proxy.ts`) auto-reloads on `src/**/*.ts` changes. If the host already has a session, restart Claude Code (or whichever MCP host) so it picks up the new code.
3. **Exercise via the dev MCP**: call the relevant `mcp__gmail-mcp-dev__*` tool(s) and confirm the change. For changes the host can't easily reach (signal handling, watchdog kill, etc.), use a one-shot bash test piping JSON-RPC through the proxy.
4. **Add a regression test** when the change is unit-testable. Vitest tests live next to the source (`*.test.ts`). The robustness library has full unit coverage — keep it that way.
5. **Run the full test suite**: `npm test`.
6. **Run the stress harness on changes that touch the dispatcher / lifecycle**: `npm run stress`.

This rule is non-negotiable. The dev MCP is the only way to catch issues that compile but break at runtime (e.g. silent stdout pollution, unhandled rejection paths, signal-handling regressions).

## PR & issue review

Mandatory security audit on every PR before presenting. See `.claude/skills/pr-review-sop/SKILL.md`.

## Stress harness

`scripts/stress-mcp.ts` (run via `pnpm run stress` / `npm run stress`) covers nine cases:

- handshake + tools/list returns the full catalog
- `health_check` returns `Status: healthy`
- 20 parallel `health_check` calls all stay healthy
- unknown tool name is rejected
- malformed schema input returns a usable error
- `MCP_TOOL_TIMEOUT_FORCE_MS=1` triggers a clean timeout
- SIGTERM produces exit code 0 (handler intercepted, not signal default)
- `MCP_MAX_RSS_MB=50` triggers a watchdog kill
- HTTP transport: `/health` returns 200, `/mcp` without bearer token returns 401, full `initialize → notifications/initialized → tools/list` round-trip with bearer + session-id returns the full catalog

Add a case here when you ship anything that changes lifecycle, dispatch, error handling, or transport.

## Known follow-ups

- **`gmail console` interactive REPL.** Step 2 of the current bin-consolidation work. Snappy aliased commands (`i`, `s`, `r`, `mod`, …), legend printed on startup, inline `@inquirer/prompts` widgets for destructive ops. Routes through the same commander tree as the CLI so the surfaces never drift. See `~/.claude/plans/steady-doodling-cloud.md` Step 2.
- **`usage` spec generation.** Step 3 of the current bin-consolidation work. Adds `@usage-spec/commander` devDep, a `gen-usage` script, and a committed `usage.kdl` for shell completions / manpages via the [`usage`](https://usage.jdx.dev/) Rust binary.
- **Phase D — TUI MVP.** Multi-pane Ink/React app with vim-modal keyboard UX, external-editor compose flow, in-memory LRU cache, themes (default ASCII / dracula / solarized / nord / nerd-font). Now wired as `gmail tui` subcommand (not its own bin). See `docs/phase-d-tui-plan.md`.
- **Phase G2 — multi-tenant HTTP mode.** Defer until a real use case appears. Would add per-request OAuth introspection, per-tenant credential lookup, scope-isolated rate limiting.
- **`zod` 3 → 4** (with `zod-to-json-schema` co-bump). zod 4 changes the discriminated-union surface, default-value semantics, and error format. The 27 schemas in `tools.ts` plus the test fixtures all need review. Defer until there's a concrete reason — currently no zod 3 bug is biting us.
- **Wrap remaining Gmail call sites with `withRetry` / `rateLimitAcquire`**. The library is in place and is wired into `read_email` and `search_emails` as the canonical pattern. The other read paths (`list_inbox_threads`, `get_thread`, `download_*`, etc.) and the idempotent writes (`modify_*`, `delete_*`, `batch_*`) are progressive-adoption candidates. Send/draft creation must remain unwrapped (non-idempotent).
- **`mcp-evals` 1 → 2**, **`nodemailer` 7 → 8**, **`open` 10 → 11**, **TypeScript 5.x → 6.x** — defer until a concrete need.
