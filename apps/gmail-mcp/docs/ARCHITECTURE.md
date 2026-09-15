# Architecture and robustness harness — gmail-mcp

> Moved out of `apps/gmail-mcp/AGENTS.md` on 2026-09-15 so that guide fits Codex's instruction cap
> (`project_doc_max_bytes`, 32,768 bytes across the root-to-app chain). Content is unchanged except that
> relative link targets gained `../`. The guide keeps the must-hold rules and links here.

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
