# Environment-variable reference — gmail-mcp

> Moved out of `apps/gmail-mcp/AGENTS.md` on 2026-09-15 so that guide fits Codex's instruction cap
> (`project_doc_max_bytes`, 32,768 bytes across the root-to-app chain). Content is unchanged except that
> relative link targets gained `../`. The guide keeps the must-hold rules and links here.

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
