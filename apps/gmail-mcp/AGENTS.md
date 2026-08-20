# Gmail-MCP-Server — Agent Guide

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
- **Package manager**: both `npm` and `pnpm` are supported. `pnpm-lock.yaml` and `package-lock.json` both live in the repo. Locally, `pnpm` is preferred. **When adding a dep, run `pnpm add <pkg>` followed by `npm install --package-lock-only` to keep both lockfiles in sync without disturbing pnpm's `node_modules` layout.** CI/published-package consumers using `npm` or `bunx` are unaffected.

## Branch workflow

`main` is the stable public branch. Use focused feature branches for changes, keep commits reviewable, and do not push generated local config or credentials. Before opening or merging a PR, run the verification commands relevant to the touched surface; for broad changes, run `pnpm verify`.

**Commit messages are Conventional Commits** (`feat(scope): …`, `fix: …`, `chore: …`, …). semantic-release derives versions and changelogs from them, so a malformed message on `main` silently produces no release. The `.githooks/commit-msg` hook runs commitlint (`commitlint.config.js`, extends `@commitlint/config-conventional`) — wire it once with `npm run hooks:install`.

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
│   ├── account-status.ts # Non-secret local auth-health checks + manifest cache
│   ├── account-service.ts# Account CRUD helpers (rename/delete)
│   ├── config-paths.ts   # getConfigDir / getOAuthPath / getCredentialsPath (env-overridable)
│   ├── session.ts        # Process session state: oauth2Client / gmail / authorizedScopes / counters
│   ├── context.ts        # OperationContext type + createContext() factory
│   ├── registry.ts       # OperationRegistry — name → {schema, handler, scopes}; dispatch()
│   ├── email-helpers.ts  # extractEmailContent / extractHeaders / extractAttachments (pure)
│   ├── batch.ts          # processBatches helper (signal-aware, per-item fallback)
│   └── ops/              # Per-category tool handlers — registry-registered at module load
│       ├── index.ts      # Barrel: imports each op file for side-effect registration
│       ├── health.ts     # health_check (no Gmail call)
│       ├── messages.ts   # read/search/modify/delete/report_phishing
│       ├── threads.ts    # get_thread, list_inbox_threads, get_inbox_with_threads, modify_thread
│       ├── labels.ts     # list_email_labels + create/update/delete/get_or_create_label
│       ├── send.ts       # send_email, reply_all + shared handleEmailAction helper
│       ├── drafts.ts     # draft_email + send/update/delete lifecycle + list_drafts
│       ├── batch-ops.ts  # batch modify/delete/report phishing
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
│   ├── account-auth.ts   # `gmail account auth` OAuth orchestration
│   ├── runtime.ts        # bootstrapForCli + runCliOp + printToolResult + helpers
│   └── commands/
│       ├── mcp.ts        # gmail mcp [--http]: run the MCP server (stdio default)
│       ├── tui.ts        # gmail tui: lazy-loads src/tui/index.ts::runTui (Phase D)
│       ├── account.ts    # account: Inquirer CRUD manager + auth/check/rename/list/use/rm/current
│       ├── auth.ts       # deprecated stub; errors and points to `gmail account`
│       ├── health.ts     # health: local canary, --json returns typed HealthSnapshot
│       ├── search.ts     # search <query>
│       ├── read.ts       # read <messageId>
│       ├── threads.ts    # threads {list, get, modify, inbox} + top-level inbox alias
│       ├── send.ts       # send/draft lifecycle/reply-all + inline images
│       ├── messages.ts   # modify, delete, report-phishing
│       ├── batch.ts      # batch-modify/delete/report-phishing
│       ├── labels.ts     # labels {list, create, update, delete, get-or-create}
│       ├── filters.ts    # filters {list, get, create, delete, template}
│       └── downloads.ts  # download-email, download-attachment
│
└── (robustness harness)  # No longer in-tree: provided by @george43g/robustness
                          # (shared kit from mcp-cli-starter-template). See
                          # "Robustness harness" below.
```

### Module boundary rules

- **Robustness comes from `@george43g/robustness`** (npm; source: `github.com/george43g/mcp-cli-starter-template`, `packages/robustness/`). Do NOT re-grow a local `src/robustness/` — gaps or bugs in the package are work orders for the starter repo (its session confers with the other consumers and publishes fixes), not local forks.
- **`src/core/credentials.ts`, `src/core/config-paths.ts`, `src/core/session.ts` (no runtime imports), `src/core/registry.ts`, `src/core/context.ts`, `src/core/batch.ts`, `src/core/email-helpers.ts`** — Gmail-agnostic shape handling. No `googleapis` / `google-auth-library` imports.
- **`src/core/auth-flow.ts`** — imports `google-auth-library` because OAuth-via-Google is intrinsic.
- **`src/core/ops/*.ts`** — uses `ctx.gmail` from OperationContext to make Gmail API calls. No top-level `googleapis` imports needed; the typed handle comes via the context.
- **`src/server/*.ts`** — wires the MCP SDK Server to the registry. Consumes `core/session` to read OAuth state.
- **`src/cli/*.ts`** — CLI surface (the `gmail` bin). Calls `callMcpTool` from `src/index.ts` for tool dispatch; `account-auth.ts` runs the OAuth flow for `gmail account auth`; `mcp` calls `main()` to start the server.
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

The harness is the **`@george43g/robustness`** package (shared kit published from
`mcp-cli-starter-template`; this repo's former `src/robustness/` was its ancestor and was replaced
by the package in the EQ-Stack-convergence refactor). Everything below still describes the runtime
behavior — module semantics, env knobs, NDJSON records, and exit codes are unchanged. Repo-specific
wiring to know:
- `src/index.ts` calls `setLogFilePrefix("gmail-mcp")` at module load so log files keep the
  `$TMPDIR/gmail-mcp/gmail-mcp-<pid>-<ts>.ndjson` naming (the package default prefix is `mcp`).
- The `shutdown` NDJSON marker is written by a **once-guarded** cleanup in `main()` — the package's
  exit listener sweeps the cleanup registry synchronously after the async pass, so an unguarded
  write would land twice. The marker's reason comes from `getShutdownCause()`
  (`signal:SIGTERM` / `stdin_eof` / `orphaned` / `watchdog:<reason>` / `normal`).
- The package's unit coverage lives upstream; this repo pins the CONTRACT from outside via the
  stress harness (10 lifecycle cases) + `src/index.test.ts` + `src/server/*.test.ts`.

| Module | What it does |
|---|---|
| `shutdown.ts` | Cleanup registry. Traps SIGINT/SIGTERM/SIGHUP/SIGQUIT, stdin EOF (host died), parent-PID watchdog (orphan reparent). 3s safety force-exit. |
| `logger.ts` | Structured logs to `MCP_LOG_DIR/gmail-mcp-<pid>-<ts>.ndjson` + in-memory 500-line ring. `info/warn/error/perf` levels. `logStartup`/`logShutdown` markers — file without a `shutdown` entry indicates a crash. |
| `watchdog.ts` | Three monitors. Event-loop p99 lag → kill at 10s default. RSS cap or sustained heap growth → kill. 24h uptime + 1h idle → graceful restart. All env-tunable. |
| `with-timeout.ts` | `Promise.race` per dispatch with `ToolTimeoutError`. Per-tool map + global default. |
| `health.ts` | Pure formatter — never touches Gmail. Reads watchdog state + caller-supplied counters → `Status: healthy/degraded/unhealthy` text. |
| `env.ts` | Validated env-var helpers. All robustness knobs use `MCP_*` prefix. |

### Self-healing contract (who installs what)

The watchdog + signal handlers are installed by transport-owning `main()` calls in `src/index.ts`, **not** by `bootstrapSession()` or `main({skipTransport:true})`. This is load-bearing — it lets the CLI/TUI/console own their lifecycle and lets the TUI catch `BootstrapError` to render a "credentials missing" pane instead of exiting. The contract is pinned by `src/index.test.ts` (asserts both bootstrap paths register 0 SIG* listeners); signal wiring itself is covered upstream in the package's own suite plus this repo's stress harness.

Self-healing surface covered by tests:
- **Per-tool timeout** (`MCP_TOOL_TIMEOUT_DEFAULT_MS`, default 30s) → one hung handler returns `isError:true` envelope; the next call still routes through the dispatcher. Stress case `MCP self-heals: serves the next call after a timed-out one`.
- **RSS cap** (`MCP_MAX_RSS_MB`, default 1024) → graceful kill, `watchdog_kill: rss_exceeded` line in NDJSON. Stress case asserts the NDJSON record exists for post-mortem grep.
- **Memory leak** (`MCP_HEAP_GROWTH_SAMPLES` consecutive monotonically-growing heap samples) → `watchdog_kill: memory_leak_suspected`.
- **Event-loop lag** (`MCP_EVENT_LOOP_KILL_MS`, default 10s p99) → `watchdog_kill: event_loop_blocked`.
- **Idle restart** (`MCP_RESTART_AFTER_MS` uptime + `MCP_RESTART_QUIET_MS` idle, defaults 24h + 1h) → graceful `shutdown(0)`, `watchdog_kill: idle_restart`.
- **Signals + lifecycle**: SIGINT (exit 130), SIGTERM/SIGHUP/SIGQUIT (exit 0); stdin EOF (host died → graceful exit); orphan reparent (ppid → 1 or different → graceful exit).
- **Bootstrap failure**: `bootstrapSession` throws `BootstrapError(stage, cause)` instead of calling `shutdown` — `main()` catches and exits(1) for CLI/MCP; TUI catches and renders.

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
| `GMAIL_SCOPES` | unset | Default scope set used by `gmail account auth` when `--scopes=` is not passed. Comma- or space-separated shorthand names. |
| `GMAIL_AUTH_NON_INTERACTIVE` | unset | `1` forces non-interactive auth (skip the checkbox prompt, fall back to defaults). Auto-detected when `CI=true` or stdin is not a TTY. |
| `GMAIL_HTTP_TOKEN` | unset (required for `--http`) | Bearer token gating `/mcp` requests in HTTP mode. Server refuses to start if `--http` is set but this is empty. Generate with `openssl rand -hex 32`. |
| `GMAIL_ACCOUNT` | unset | Active account id. Selects which entry in `<configDir>/accounts/` to load. CLI flag `-a/--account` overrides. Falls back to `accounts.json` `defaultAccount`, then to the sole-account / legacy-implicit branches. See [Multi-account layout](#multi-account-layout). |

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

`<configDir>/accounts.json` is the manifest, and `<configDir>/accounts/<id>/credentials.json` is the per-account token file. Implementation in `src/core/accounts.ts`. The active account is resolved at bootstrap (in `src/index.ts::loadCredentials`) and passed to both `loadOAuthKeys({accountId})` and `coreLoadCredentials({accountId})`.

**Active-account precedence (first hit wins, in `resolveActiveAccount`):**
1. `-a, --account <id>` global CLI flag (stamped into `process.env.GMAIL_ACCOUNT` by the root commander preAction hook).
2. `GMAIL_ACCOUNT` env var.
3. `accounts.json` `defaultAccount`.
4. Sole account in `accounts.json`, if there's exactly one.
5. Legacy-implicit `"default"` — only when no manifest exists AND a legacy `<configDir>/credentials.json` exists AND no env-driven credential source is configured. Triggers the M1 migration shim (copy, not move) on first read.
6. `null` — no account configured.

**File layout (after migration):**

```
<configDir>/
├── accounts.json                       # manifest: {defaultAccount, accounts: {…}}
├── gcp-oauth.keys.json                 # shared OAuth client keys (fallback)
├── credentials.json                    # legacy file, kept for one minor release
└── accounts/
    ├── default/credentials.json        # promoted from legacy file on first read
    ├── work/credentials.json
    └── personal/
        ├── credentials.json
        └── gcp-oauth.keys.json         # per-account OAuth keys override (optional)
```

**OAuth keys resolution** (in `loadOAuthKeys` when `accountId` is supplied):
1. `GMAIL_OAUTH_KEYS_JSON` env (always wins).
2. `<configDir>/accounts/<id>/gcp-oauth.keys.json` — per-account override, if present.
3. `GMAIL_OAUTH_PATH` env / `<configDir>/gcp-oauth.keys.json` — the shared file.
4. Error.

**Migration trigger:** the first `loadCredentials({accountId: "default"})` call where `accounts/default/credentials.json` is missing but `<configDir>/credentials.json` exists copies the legacy file and stamps the manifest with a single `default` entry. Idempotent; no-op once the new file is in place. The legacy file is intentionally not deleted — a downgrade still works.

**Env-driven mode is single-account by design.** `GMAIL_CREDENTIALS_JSON` / `GMAIL_CREDENTIALS_OP` always win over the file loader regardless of `accountId`. If you set them alongside `GMAIL_ACCOUNT`, the credentials still come from env; the account id is used only for the OAuth-keys override fallback and for log tagging. Pure-env multi-account would require per-account env vars (`GMAIL_CREDENTIALS_<ID>_JSON`) and is deferred to Phase M3.

**Subcommands:** `gmail account` opens the Inquirer CRUD manager in a TTY. Scriptable commands are `gmail account {auth [id], list, current, use <id>, rm <id>, check [id|--all], rename <old> <new>}`. `auth` creates or re-authenticates an account; `check` caches non-secret auth-health metadata in the manifest; `rm` deletes both the manifest entry and (unless `--keep-files`) the on-disk directory.

**MCP tools (M2-light):** Two meta-tools expose the same surface to MCP hosts, split for permission-gating:

- `list_accounts` — read-only. Returns `{active: {id, source, isLegacyImplicit}, count, accounts: [{id, emailAddress, scopes, isDefault, isActive, createdAt}]}`. No Gmail API call; `readOnlyHint: true`. Annotated so hosts allow it freely.
- `switch_account` — write/state-change. Input `{accountId}`. Validates the id exists in the manifest, loads its OAuth keys + credentials, builds a fresh `OAuth2Client` + `gmail` handle, and calls `setSession()` to swap atomically. Returns `{previousAccountId, newAccountId, emailAddress, scopes, note}`. Idempotent when switching to the already-active id. Annotated `destructiveHint: false, idempotentHint: false` so hosts can permission-gate it as a write.

Both tools live in `src/core/ops/accounts.ts` and require no Gmail scope (`scopes: []`). The session module (`src/core/session.ts`) tracks `_currentAccountId` and exposes `getCurrentAccountId()` for the list output's `isActive` flag.

**Caveat — stale tool catalog after switch:** the host's cached `tools/list` does NOT auto-refresh when the active account changes. If the new account has narrower scopes than the previous one, affected tools will reject at call-time with the usual re-auth hint. The `switch_account` response includes a `note` field documenting this. Sending `notifications/tools/list_changed` after the swap is a Phase M2-full polish item; deferred.

**Non-goals (current multi-account model):**
- No simultaneous per-request multi-account fan-out. A process has one active account at a time.
- No per-tool `account` argument on Gmail tools (deferred to a future multi-account request model).
- Hosts that want two accounts available without a stateful `switch_account` call should run two `gmail mcp` processes with different `GMAIL_ACCOUNT` envs.

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
| `auth` | (deprecated) | Stub only. Exits non-zero and tells users to run `gmail account`. |
| `account` | (account CRUD + OAuth) | Bare command opens the Inquirer manager. Scriptable ops: `auth [id]`, `list`, `current`, `use <id>`, `rm <id>`, `check [id|--all]`, `rename <old> <new>`. |
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
| `send-draft <draftId>` | `send_draft` | Atomically sends and removes an existing draft |
| `update-draft <draftId>` | `update_draft` | Same message flags as `send`; replaces draft content |
| `delete-draft <draftId>` | `delete_draft` | Deletes a draft |
| `list-drafts` | `list_drafts` | Lists saved drafts (subject, recipients, thread id, snippet). `--max`, `--page-token`, `--json` |
| `reply-all <messageId>` | `reply_all` | Auto-builds To/CC and threading headers from the original; `-b` body required |
| `modify <messageId>` | `modify_email` | `--add ids`, `--remove ids` |
| `delete <messageId>` | `delete_email` | Permanent (irreversible) |
| `batch-modify` | `batch_modify_emails` | `--ids` comma-separated or `@file.txt`; `--add`, `--remove`, `--batch-size`; max 500 |
| `batch-delete` | `batch_delete_emails` | `--ids` same syntax; `--batch-size`; max 500 |
| `report-phishing <messageId>` | `report_phishing` | Applies SPAM; Gmail has no native public phishing endpoint |
| `batch-report-phishing` | `batch_report_phishing` | Applies SPAM to `--ids`; max 500 |
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
| `mcp [--http]` | (transport) | Starts the MCP server; supports `--tool-prefix`, plus HTTP `--port`, `--bind`, `--token-env` |
| `tui` | — | Full multi-pane Ink/React terminal client |
| `console` | — | Interactive REPL. Supports snappy aliases plus `accounts` and `switch <id>` / `sw <id>` for in-session account switching. |

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

## Known follow-ups

- **`gmail console` polish.** The REPL exists, prints a legend, routes through the commander tree, and supports `accounts` plus `switch <id>` / `sw <id>`. Future polish: inline `@inquirer/prompts` widgets for destructive ops and richer account/status summaries.
- **`usage.kdl` spec for shell completions.** Generated from the commander tree by `scripts/gen-usage.ts` (run via `pnpm run gen-usage`). `pnpm verify` runs `gen-usage --check` so drift fails CI. The committed `usage.kdl` is consumed by the [`usage`](https://usage.jdx.dev/) Rust binary; `gmail --usage-spec` also prints it on demand.
- **TUI follow-ups.** `gmail tui` opens a 3-pane Ink/React UI against the in-process dispatcher: vim-modal keymap, `$EDITOR` suspend for compose / reply / reply-all / draft-edit, 8 themes (`:theme` overlay), account switcher (`:account` modal that subscribes to `sessionEvents.accountChanged`), dev stats overlay (`~` / `:stats`), per-thread LRU cache (`GMAIL_TUI_CACHE_MB`). **Draft recovery (D2):** every compose persists a `<kind>-<ts>[-n].eml` under `<configDir>/drafts/` carrying `X-Gmail-MCP-Kind`/`-Source-Message-Id`/`-Source-Thread-Id` breadcrumbs (built + parsed + stripped-before-send in `compose-parser.ts`); `p` / `:drafts` opens the recovery picker (`DraftsRecovery.tsx`, list/resume/discard), `:resume` reopens the most recent, and `e` (`msg.draft.edit`) now correlates the focused draft to a server-side draft via `list_drafts` and edits it in place with `update_draft` (no duplicate). Reads `~/.gmail-mcp/config.json` for `theme` / `editor` / `cacheMB`; `GMAIL_TUI_*` env wins over the file. Follow-ups: visual-mode batch ops, filter/label CRUD UI, attachment preview, sent/drafts folder UIs.
- **Shared-kit convergence (EQ-Stack prep).** `@george43g/robustness` fully adopted (local `src/robustness/` deleted); `@george43g/tui-kit` adopted for `truncateToWidth`/`visualWidth` at the emoji-truncation sites (full TUI-kit adoption deliberately deferred — the kit's tree-navigator redesign is in flight upstream). **mcp-kit adoption deferred pending upstream seams**: its handler shape has no per-session context injection (ours is rebuilt by `switch_account`) and its text envelope is `JSON.stringify(structured)` (ours is a hand-authored wire contract); scope-gating + async auth-error remediation are also absent. All four filed as work orders with `mcp-cli-starter-template`; adopt once the kit grows the seams rather than forking 36 tools' output format here.
- **Release automation (Phase 0)** ✅ shipped. semantic-release + commitlint. `.releaserc.json`: branches `["main"]`, tag `v${version}`, plugin order commit-analyzer → release-notes-generator → changelog → **npm → exec → git** — exec's `prepareCmd` (`gen-usage` + `npm install --package-lock-only`) runs **after** the npm plugin stamps the new version, so `usage.kdl` and the lockfile pick it up; the git plugin then commits `package.json` / both lockfiles / `usage.kdl` / `CHANGELOG.md` as `chore(release): x.y.z [skip ci]`. `.github/workflows/release.yml` fires on CI success on `main` and publishes via **npm OIDC trusted publishing** (`permissions: id-token: write`, provenance automatic, **no `NPM_TOKEN` secret**; do not add `registry-url` to `setup-node` — its `.npmrc` breaks the plugin's auth). It shares the `main-mutations` concurrency group with `screenshots.yml`'s auto-commit job so the two never push to `main` concurrently. `ci.yml`'s version asserts read `package.json` instead of a hardcoded string. ⚠ **Merging this to `main` arms auto-publish**: the next `feat`/`fix` commit on `main` with green CI cuts a real npm release — merge deliberately.
- **VHS screenshot pipeline** ✅ shipped. `pnpm screenshots` regenerates `docs/screenshots/*.{png,gif}` from `scripts/screenshots/*.tape` against `GMAIL_FIXTURE_MODE=1`. The 6 stills + animated workflow GIF feed the top-level README and `docs/SCREENSHOTS.md` gallery. CI (`.github/workflows/screenshots.yml`) auto-regenerates on push (auto-commits with `[skip ci]`) and gates PRs (`git diff --exit-code`). Local pre-push hook at `.githooks/pre-push` refuses to push TUI changes that drift the captures.
- **Phase G2 — multi-tenant HTTP mode.** Defer until a real use case appears. Would add per-request OAuth introspection, per-tenant credential lookup, scope-isolated rate limiting.
- **`zod` 3 → 4** (with `zod-to-json-schema` co-bump). zod 4 changes the discriminated-union surface, default-value semantics, and error format. The schemas in `tools.ts` plus the test fixtures all need review. Defer until there's a concrete reason — currently no zod 3 bug is biting us.
- **Wrap remaining Gmail call sites with `withRetry` / `rateLimitAcquire`**. The library is in place and is wired into `read_email` and `search_emails` as the canonical pattern. The other read paths (`list_inbox_threads`, `get_thread`, `download_*`, etc.) and the idempotent writes (`modify_*`, `delete_*`, `batch_*`) are progressive-adoption candidates. Send/draft creation must remain unwrapped (non-idempotent).
- **`mcp-evals` 1 → 2**, **`nodemailer` 7 → 8**, **`open` 10 → 11**, **TypeScript 5.x → 6.x** — defer until a concrete need.

## MCP servers (project scope)

Canonical set: `.mcp.json` (standard MCP schema, `${VAR}` placeholders only —
never literal secrets). `.cursor/mcp.json` and `.warp/.mcp.json` are symlinks
to it. `opencode.json`'s `mcp` key is GENERATED — after editing `.mcp.json`,
run: `node ~/dotfiles/mcp/render.js --manifest .mcp.json --opencode opencode.json`.
Global servers and scope decisions: `~/dotfiles/docs/mcp-registry.md`.
