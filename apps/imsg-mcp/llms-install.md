# imsg-mcp — Install Reference (for LLMs and end users)

This page is what an LLM agent (or a user being walked through setup) should read to configure `imsg-mcp` in any MCP host. The README is for marketing & overview; this file is for **getting it running**.

## What it does

iMessage MCP server for macOS. Lets agents read your chat.db (messages, contacts, attachments, threads), send iMessage/SMS, and run rich analytics — without leaving your laptop. All data stays local.

## Prerequisites (macOS only)

1. **macOS 13+** with the system `Messages.app`.
2. **Node.js 24+** (`node --version`).
3. **Full Disk Access** for whatever process runs the MCP — usually your terminal or IDE. System Settings → Privacy & Security → Full Disk Access → add Terminal / iTerm / Cursor / Warp.
4. **Automation permission** for the same process to control `Messages` — granted on first send attempt; if denied, re-grant in System Settings → Privacy & Security → Automation.

## Install

```bash
npx imsg mcp --help
```

or pin a version:

```bash
npx imsg@1 mcp
```

For development / running from a clone:

```bash
git clone https://github.com/george43g/imsg-mcp
cd imsg-mcp
pnpm install
pnpm build
node dist/cli.js mcp
```

## MCP host configuration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imsg", "mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imsg", "mcp"]
    }
  }
}
```

### Warp

`~/.warp/mcp_servers.json`:

```json
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imsg", "mcp"]
    }
  }
}
```

### Generic / development (this repo, hot-reload via dev-proxy)

`./.mcp.json` in this repo already configures it; works in any MCP-aware host that reads project-local `.mcp.json`:

```json
{
  "mcpServers": {
    "imessage-mcp-dev": {
      "command": "/path/to/imsg-mcp/node_modules/.bin/tsx",
      "args": ["/path/to/imsg-mcp/scripts/mcp-dev-proxy.ts"],
      "env": {
        "MCP_DEV_CMD": "/path/to/imsg-mcp/node_modules/.bin/tsx /path/to/imsg-mcp/src/cli.ts mcp"
      }
    }
  }
}
```

The dev proxy keeps the MCP server alive across restarts and replays the protocol handshake. It also injects `IMSG_DEV=1` so dev-only tools (`health_check`, `get_logs`, `run_build`, `request_restart`, `get_last_send_error`) are visible to your agent.

## Environment variables

All optional. Set in the MCP host config's `env` block or in a project `.env` file when running locally.

| Variable | Purpose | Default |
|---|---|---|
| `IMSG_DEV` | `"1"` exposes dev-only MCP tools and writes NDJSON logs to `$TMPDIR/imsg-mcp/`. End users should leave this UNSET. | unset |
| `IMSG_LOG_VERBOSE` | `"1"` lowers the heartbeat interval to 10s and logs every DB query duration. Only meaningful when `IMSG_DEV=1`. | unset |
| `VITE_IMSG_DB_PATH` | Override the chat.db path. | `~/Library/Messages/chat.db` |
| `VITE_CONTACTS_DB_PATH` | Override the Address Book DB path. | `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb` |
| `VITE_SLUGS_DB_PATH` | Where the thread-slug ↔ chat-GUID map is persisted. | `~/.imsg-mcp/slugs.db` |
| `IMSG_DISABLE_NATIVE` | `"1"` forces the TypeScript fallback even if the Rust native module is built. | unset |
| `IMSG_EVENT_LOOP_KILL_MS` | Watchdog: event-loop p99 ms past which the process self-kills for the host to respawn. | 10000 |
| `IMSG_MAX_RSS_MB` | Watchdog: RSS threshold (MB) past which the process self-kills. | 1024 |
| `IMSG_RESTART_AFTER_MS` | Watchdog: uptime in ms past which the process restarts when idle ≥1h. | 86400000 (24h) |

## CLI subcommands (alternatives to `mcp`)

The `imsg` binary dispatches several modes:

| `imsg <cmd>` | Purpose |
|---|---|
| `imsg mcp` | stdio MCP server (what hosts call). |
| `imsg cli` | Interactive REPL — same data, no host needed. |
| `imsg tui` | Full-screen terminal UI (Ink). Vim keybinds. `j/k`, `gg/G`, `Ctrl-d/u`, `:` date jump, `o` open attachment via Quick Look. |
| `imsg doctor` | Check permissions + database access; prints a remediation report. |
| `imsg setup` | Walk through Full Disk Access / Automation grants. |
| `imsg config` | Print resolved config paths. |

## Validating the install

After configuring your host, restart it and try:

> "Use the imessage MCP to list my last 5 conversations."

If you see `Error: Operation not permitted` → grant Full Disk Access. If you see `Can't get buddy …` → the recipient handle isn't an iMessage/SMS reachable account (try `check_imessage_availability` first).

Run `imsg doctor` from a terminal to get a structured permissions report.

## Tool surface (prod mode, IMSG_DEV unset)

| Tool | Purpose |
|---|---|
| `get_messages` | Recent messages (optionally filtered by chat). Supports `beforeMessageId` for pagination. |
| `get_unread_messages` | All unread messages. |
| `send_message` | Send to a `recipient` or `threadSlug`. Uses temp-file UTF-8 + SMS auto-fallback for reliability. |
| `wait_for_reply` | Block until a new message arrives in a chat (honors MCP cancellation). |
| `list_conversations` | List chats with `threadSlug`, snippets, unread counts. |
| `search_messages` | Substring search (fuzzy mode planned for v1.1). |
| `export_messages` | Stream a conversation to a file (markdown/csv/json/ndjson). |
| `list_contacts`, `search_contacts`, `get_contact`, `resolve_handle` | Address Book surface. |
| `check_imessage_availability` | Preflight reachability check — call before `send_message`. |

Dev-mode also exposes: `health_check`, `get_logs`, `get_last_send_error`, `run_build`, `request_restart`.

## Where to file issues

GitHub: https://github.com/george43g/imsg-mcp/issues

Include:
- macOS version + Node version (`uname -a; node -v`).
- Output of `imsg doctor`.
- A redacted NDJSON log from `$TMPDIR/imsg-mcp/` if `IMSG_DEV=1` was set when the issue occurred.
