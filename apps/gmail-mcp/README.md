# Gmail MCP Server

[![CI](https://github.com/george43g/gmail-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/george43g/gmail-mcp/actions/workflows/ci.yml)

An actively maintained Gmail integration for MCP hosts, plus a human-friendly
`gmail` CLI, interactive console, and terminal UI.

This fork descends from [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)
and incorporates the maintained fork history from `ArtyMcLabin/Gmail-MCP-Server`.
Upstream authors and contributors are credited in the Git history and license.

### What this fork adds

- **Fixed reply threading** — auto-resolves `In-Reply-To` and `References` headers so email replies land in the correct thread instead of creating orphaned messages
- **Send-as alias support** — optional `from` parameter for multi-identity email management (send from any configured Gmail alias)
- **Reply-all tool** — `reply_all` automatically fetches the original email, builds To/CC recipient lists (excluding yourself), and sets proper threading headers
- **Custom OAuth2 scoping** — `--scopes` flag to request only the permissions you need, with automatic tool filtering
- **Multi-account management** — account manifests, `gmail account`, `list_accounts`, `switch_account`, and account-aware console/TUI browsing
- **Thread-level tools** — `get_thread`, `list_inbox_threads`, `get_inbox_with_threads` for efficient thread-based email reading in a single call
- **Tool annotations** — MCP spec annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on all tools for safer LLM tool execution
- **Download email tool** — `download_email` saves emails to disk in json/eml/txt/html formats without consuming LLM context
- **TUI and console** — `gmail tui` for a keyboard-driven terminal client and `gmail console` for a REPL over the same tool catalog

---

A Model Context Protocol (MCP) server for Gmail integration in Claude Desktop with auto authentication support. This server enables AI assistants to manage Gmail through natural language interactions.

![](https://badge.mcpx.dev?type=server 'MCP Server')


## Screenshots

![gmail tui — workflow demo](https://raw.githubusercontent.com/george43g/gmail-mcp/main/docs/screenshots/workflow-demo.gif)

The animated demo above shows `gmail tui` booting against the fixture
corpus, opening a thread, swapping accounts, and toggling the dev-stats
overlay. The full gallery (theme picker, compose flow, account
switcher, per-pane stills) lives in [`docs/SCREENSHOTS.md`](docs/SCREENSHOTS.md);
regenerate locally with `pnpm screenshots`.


## Features

- Send emails with subject, content, **attachments**, and recipients
- **Full attachment support** - send and receive file attachments
- **Download email attachments** to local filesystem
- **Download full emails** to files in json/eml/txt/html formats
- **Thread-level operations** — get full threads, list inbox threads, batch-expand threads
- Support for HTML emails and multipart messages with both HTML and plain text versions
- Full support for international characters in subject lines and email content
- Read email messages by ID with advanced MIME structure handling
- **Enhanced attachment display** showing filenames, types, sizes, and download IDs
- Search emails with various criteria (subject, sender, date range)
- **Comprehensive label management with ability to create, update, delete and list labels**
- List all available Gmail labels (system and user-defined)
- List emails in inbox, sent, or custom labels
- Mark emails as read/unread
- Move emails to different labels/folders
- Delete emails
- **Batch operations for efficiently processing multiple emails at once**
- Full integration with Gmail API
- Simple OAuth2 authentication flow with auto browser launch
- Support for both Desktop and Web application credentials
- Global credential storage for convenience

## Installation & Authentication

### Installing Manually
1. Create a Google Cloud Project and obtain credentials:

   a. Create a Google Cloud Project:
      - Go to [Google Cloud Console](https://console.cloud.google.com/)
      - Create a new project or select an existing one
      - Enable the Gmail API for your project

   b. Create OAuth 2.0 Credentials:
      - Go to "APIs & Services" > "Credentials"
      - Click "Create Credentials" > "OAuth client ID"
      - Choose either "Desktop app" or "Web application" as application type
      - Give it a name and click "Create"
      - For Web application, add `http://localhost:3000/oauth2callback` to the authorized redirect URIs
      - Download the JSON file of your client's OAuth keys
      - Rename the key file to `gcp-oauth.keys.json`

2. Run Authentication:

   You can authenticate in two ways:

   a. Global Authentication (Recommended):
   ```bash
   # First time: Place gcp-oauth.keys.json in your home directory's .gmail-mcp folder
   mkdir -p ~/.gmail-mcp
   mv gcp-oauth.keys.json ~/.gmail-mcp/

   # Run authentication from anywhere
   npx @george43g/gmail-mcp account auth default
   ```

   b. Local Authentication:
   ```bash
   # Place gcp-oauth.keys.json in your current directory
   # The file will be automatically copied to global config
   npx @george43g/gmail-mcp account auth default
   ```

   The authentication process will:
   - Look for `gcp-oauth.keys.json` in the current directory or `~/.gmail-mcp/`
   - If found in current directory, copy it to `~/.gmail-mcp/`
   - Open your default browser for Google authentication
   - Save credentials as `~/.gmail-mcp/accounts/default/credentials.json`

   > **Note**: 
   > - After successful authentication, credentials are stored globally in `~/.gmail-mcp/accounts/<id>/` and can be used from any directory
   > - Both Desktop app and Web application credentials are supported
   > - For Web application credentials, make sure to add `http://localhost:3000/oauth2callback` to your authorized redirect URIs

3. Configure in Claude Desktop:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": [
        "@george43g/gmail-mcp",
        "mcp"
      ]
    }
  }
}
```

### Docker Support

If you prefer using Docker:

1. Authentication:
```bash
docker run -i --rm \
  --mount type=bind,source=/path/to/gcp-oauth.keys.json,target=/gcp-oauth.keys.json \
  -v mcp-gmail:/gmail-server \
  -e GMAIL_OAUTH_PATH=/gcp-oauth.keys.json \
  -e "GMAIL_CREDENTIALS_PATH=/gmail-server/credentials.json" \
  -p 3000:3000 \
  george43g/gmail-mcp account auth default
```

2. Usage:
```json
{
  "mcpServers": {
    "gmail": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "mcp-gmail:/gmail-server",
        "-e",
        "GMAIL_CREDENTIALS_PATH=/gmail-server/credentials.json",
        "george43g/gmail-mcp",
        "mcp"
      ]
    }
  }
}
```

### Cloud Server Authentication

For cloud server environments (like n8n), you can specify a custom callback URL during authentication:

```bash
npx @george43g/gmail-mcp account auth default --callback https://gmail.example.com/oauth2callback
```

#### Setup Instructions for Cloud Environment

1. **Configure Reverse Proxy:**
   - Set up your n8n container to expose a port for authentication
   - Configure a reverse proxy to forward traffic from your domain (e.g., `gmail.example.com`) to this port

2. **DNS Configuration:**
   - Add an A record in your DNS settings to resolve your domain to your cloud server's IP address

3. **Google Cloud Platform Setup:**
   - In your Google Cloud Console, add your custom domain callback URL (e.g., `https://gmail.example.com/oauth2callback`) to the authorized redirect URIs list

4. **Run Authentication:**
   ```bash
   npx @george43g/gmail-mcp account auth default --callback https://gmail.example.com/oauth2callback
   ```

5. **Configure in your application:**
   ```json
   {
     "mcpServers": {
       "gmail": {
         "command": "npx",
         "args": [
           "@george43g/gmail-mcp",
           "mcp"
         ]
       }
     }
   }
   ```

This approach allows authentication flows to work properly in environments where localhost isn't accessible, such as containerized applications or cloud servers.

## OAuth Scopes

You can limit the server's Gmail access by specifying OAuth scopes during authentication. This controls which tools are available to the LLM, reducing the attack surface for sensitive operations.

### Available Scopes

| Scope | Description |
|-------|-------------|
| `gmail.readonly` | Read-only access to emails (search, read, download attachments) |
| `gmail.modify` | Full read/write access to emails (superset of `readonly` - includes sending, modifying, deleting) |
| `gmail.compose` | Create drafts and send emails only |
| `gmail.send` | Send emails only |
| `gmail.labels` | Manage labels only |
| `gmail.settings.basic` | Manage filters and settings |

> **Note**: `gmail.modify` is a superset that includes all read capabilities. You don't need `gmail.readonly` if you have `gmail.modify`.

### Authenticating with Specific Scopes

Use the `--scopes` flag to request only the permissions you need:

```bash
# Read-only access (recommended for safe browsing)
npx @george43g/gmail-mcp account auth default --scopes=gmail.readonly

# Read-only with filter management
npx @george43g/gmail-mcp account auth default --scopes=gmail.readonly,gmail.settings.basic

# Full access (default behavior)
npx @george43g/gmail-mcp account auth default --scopes=gmail.modify,gmail.settings.basic
```

If no `--scopes` flag is provided, the server defaults to `gmail.modify,gmail.settings.basic` for full functionality.

### Scope-to-Tool Mapping

The server automatically filters available tools based on your authorized scopes:

| Tools | Required Scope (any) |
|-------|---------------------|
| `read_email`, `search_emails`, `download_attachment` | `gmail.readonly` or `gmail.modify` |
| `list_email_labels` | `gmail.readonly`, `gmail.modify`, or `gmail.labels` |
| `send_email`, `draft_email`, `reply_all` | `gmail.modify`, `gmail.compose`, or `gmail.send` |
| `modify_email`, `delete_email`, `batch_modify_emails`, `batch_delete_emails` | `gmail.modify` |
| `create_label`, `update_label`, `delete_label`, `get_or_create_label` | `gmail.modify` or `gmail.labels` |
| `list_filters`, `get_filter`, `create_filter`, `delete_filter`, `create_filter_from_template` | `gmail.settings.basic` |

### Re-authenticating

To change your scopes, run `gmail account auth <id>` again with different scopes. This replaces that account's credentials.

## Claude Code CLI Configuration

To use this MCP server with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), add it to your MCP settings.

### Read-Only Configuration (Recommended for Safe Browsing)

First, authenticate with read-only scope:

```bash
npx @george43g/gmail-mcp account auth default --scopes=gmail.readonly
```

Then add to your Claude Code MCP settings (`~/.claude/mcp_settings.json` or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["@george43g/gmail-mcp", "mcp"]
    }
  }
}
```

With read-only scopes, only these 4 tools will be available to Claude:
- `read_email` - Read email content
- `search_emails` - Search your inbox
- `list_email_labels` - List available labels
- `download_attachment` - Download attachments

### Full Access Configuration

For full Gmail management capabilities:

```bash
npx @george43g/gmail-mcp account auth default --scopes=gmail.modify,gmail.settings.basic
```

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["@george43g/gmail-mcp", "mcp"]
    }
  }
}
```

This enables the full tool catalog, including sending emails, managing labels, creating filters, reply-all, account switching, and batch operations.

## Other MCP Hosts

This server speaks the standard MCP stdio protocol — any host that supports MCP can talk to it. All examples below assume you've already run `gmail account auth default` (or `npx @george43g/gmail-mcp account auth default`) once on a machine with a browser. The credentials end up in `~/.gmail-mcp/accounts/default/credentials.json`.

> **Bin layout change (May 2026):** the package now ships a single `gmail` binary. Subcommands `mcp` / `tui` / `console` expose the MCP server, terminal UI, and interactive REPL. Bare `gmail` prints help. **Update existing host configs** that say `args: ["@george43g/gmail-mcp"]` to `args: ["@george43g/gmail-mcp", "mcp"]` — the trailing `mcp` is required, since the CLI is now the default surface.

If you want to skip the file entirely (CI, Docker, remote server), see [Env-Driven Config](#env-driven-config-no-gmail-mcp-files-needed).

### Cursor (`~/.cursor/mcp.json` or project `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "gmail": {
      "type": "stdio",
      "command": "npx",
      "args": ["@george43g/gmail-mcp", "mcp"]
    }
  }
}
```

### Warp (auto-discovers `.mcp.json` in the project)

Same shape as Claude Code's `.mcp.json` — drop the snippet above into project root and Warp picks it up.

### OpenCode (`opencode.json`)

```json
{
  "mcp": {
    "gmail": {
      "type": "local",
      "command": "npx",
      "args": ["@george43g/gmail-mcp", "mcp"]
    }
  }
}
```

### Continue (`~/.continue/config.json`)

```json
{
  "mcpServers": [
    {
      "name": "gmail",
      "command": "npx",
      "args": ["@george43g/gmail-mcp", "mcp"]
    }
  ]
}
```

### VS Code + Cline

Open Cline's MCP-server settings (gear icon → "Configure MCP Servers") and paste the same JSON shape as Claude Desktop.

### Faster startup with `bunx`

If you have [Bun](https://bun.sh/) installed, swap `npx` for `bunx` in any of the snippets above. Cold-start is ~2–5× faster for first-run downloads, and ~100× faster for subsequent runs from Bun's global cache. Our shebang (`#!/usr/bin/env node`) is preserved, so Bun runs the server under Node.js.

```json
{ "mcpServers": { "gmail": { "command": "bunx", "args": ["@george43g/gmail-mcp", "mcp"] } } }
```

## CLI Usage

The `gmail` bin is also a full CLI — same set of operations as the MCP, but typed for humans + scripts. Bare `gmail` prints help.

```bash
# Open the interactive account manager
gmail account

# Authenticate a named account (interactive scope picker on TTY; opens browser)
gmail account auth work

# Specific scopes, no prompt
gmail account auth work --scopes=gmail.readonly

# Remote-server flow (prints URL only — pair with SSH port-forward)
gmail account auth work --headless

# Capture credentials as env vars (for CI / Docker / 1Password / GH secrets)
gmail account auth work --print-json
# Outputs: {"GMAIL_OAUTH_KEYS_JSON": "...", "GMAIL_CREDENTIALS_JSON": "..."}

# Health check (local canary, no Gmail API call)
gmail health
gmail health --json

# Run the MCP server
gmail mcp                    # stdio
gmail mcp --http             # HTTP transport on 127.0.0.1:8080

# Per-op operations (full list: `gmail --help`)
gmail inbox -n 10
gmail search "from:noreply" --json
gmail read <messageId>
gmail labels list
gmail send -t alice@example.com -s "Subject" -b "Body"

# Streaming pagination — Gmail caps a single page at 500 results.
# `--all` (alias: `--max 0`) loops pageToken across pages and streams
# progress to stderr. Ctrl-C cancels and prints whatever was accumulated.
gmail inbox --all --json | jq '.threads | length'
gmail search "newer_than:30d" --max 1000 --json
gmail threads list --query "label:work" --all
```

The `tui` and `console` subcommands expose the terminal UI and an interactive REPL respectively. In `gmail console`, use `accounts` to list configured accounts and `switch <id>` / `sw <id>` to swap the active account for subsequent REPL commands.

### `gmail tui`

```bash
gmail tui
```

**Prerequisite — authorise an account first.** The TUI is a viewer over your Gmail; it needs an OAuth account configured before it can do anything. Run `gmail account auth <id>` once from any shell, then launch the TUI. If you start the TUI without any configured account it now shows a friendly empty-state screen with a one-key hotkey (`[a]`) that launches the interactive `gmail account auth` flow directly so you never see a stack trace on first run.

Full-screen Ink/React app with a vim-modal keymap. The drill-down layout is **Sidebar → ThreadList → MessageDetail** (with a horizontal pill row above the detail when a thread has more than one message). All four panes share the in-process dispatcher with the CLI, so every action goes through the same MCP ops, scope gates, and timeouts.

| Key | Action |
|---|---|
| `j` / `k` | Cursor down / up in the focused pane (sidebar, threads, message body) |
| `↑` / `↓` | Step messages within the open thread (focus-independent) |
| `[` / `]` | Step adjacent threads + auto-open (focus-independent) |
| `gg` / `G` | Top / bottom of list |
| `Ctrl-d` / `Ctrl-u` | Half-page down / up |
| `Ctrl-f` / `Ctrl-b` | Page down / up |
| `H` / `M` / `L` | Viewport top / middle / bottom |
| `Tab` | Cycle focus across panes |
| `l` / `Enter` | Drill into selected (label → threads → message detail) |
| `h` | Drill back (preserves the open thread — detail stays visible) |
| `q` / `Q` | Close pane / quit |
| `gi` `gs` `gd` `gt` `gS` `gI` | Go to Inbox / Sent / Drafts / Trash / Starred / Important |
| `ga` | Open account switcher |
| `r` / `R` | Reply / reply-all (opens `$EDITOR`) |
| `c` / `e` / `f` | Compose / edit draft / forward (opens `$EDITOR`) |
| `a` / `A` | Archive message / entire thread |
| `s` / `m` / `!` | Star / mark read-unread / mark spam |
| `t` / `T` | Add / remove label (inline overlay) |
| `x` | Delete (with confirm modal) |
| `y` / `Y` | Copy threadId / messageId to clipboard |
| `d` / `i` | Download all attachments / preview first image (kitty / iTerm2 / Ghostty inline; falls back to system viewer) |
| `/` | Inline search bar |
| `:` | Ex-command palette (`:q`, `:theme [name]`, `:search`, `:label`, `:account`, `:health`, `:stats`) |
| `z` | Toggle preview (focus message detail) |
| `~` | Toggle dev stats overlay |
| `?` | Fuzzy-filtered help overlay (46+ bindings, type to search) |

**Visual cues:**

- `▎` (accent bar) on the ThreadList row whose thread is currently open in the detail pane — stays visible even when the cursor or focus moves to another pane.
- `❯` (selection arrow) on the focused-cursor row.
- `│ ` left-bar prefix in border colour on quoted reply blocks and `On <date>, <name> wrote:` boundaries — makes it obvious which text is new vs quoted from earlier emails in the thread.
- Subject and body wrap freely (no `…` truncation) in the message detail pane.
- Hairline `─` separator between header block and body.

**Responsive layout** — `computeLayout(terminalCols)` picks one of three tiers automatically:

- **Compact** (≤ 120 cols): sidebar 22, threadList ~35% of remainder, detail = rest.
- **Comfortable** (121–180 cols): sidebar 24, threadList 44, detail capped at 100.
- **Wide** (≥ 181 cols): sidebar 28, detail 100 (cap holds for readability), surplus → threadList up to 80.

The detail-pane cap (100 cols) is deliberate — prose readability drops past ~80–100 chars per line.

**Single-account by design today.** The TUI surfaces one account at a time; switch via `ga` or `:account`. The underlying `BrowseScope` union still supports cross-account fan-out at the dispatcher layer for a future revival, but the UI is intentionally single-select to keep the mental model simple.

**Lazy pagination.** The ThreadList loads a 50-thread page on label change, then lazy-fetches the next page once the cursor gets within 10 of the end. The header shows `Inbox (50 / ~201)` so you know there's more to come.

Themes (`:theme <name>` or `GMAIL_TUI_THEME=…`): `default`, `mono`, `dracula`, `solarized-dark`, `solarized-light`, `nord`, `gruvbox`, `nerd` (requires a Nerd Font).

Config: `~/.gmail-mcp/config.json` (`{theme, editor, cacheMB}`); env vars `GMAIL_TUI_THEME` / `GMAIL_TUI_EDITOR` / `GMAIL_TUI_CACHE_MB` override the file. Editor resolution: `VISUAL` → `EDITOR` → `GMAIL_TUI_EDITOR` → `config.editor` → `vi`.

Fixture-mode dev loop (no real OAuth):

```bash
GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail GMAIL_ACCOUNT=work pnpm dev:tui
```

### Shell Completions / Manpages

The `gmail` bin ships a [`usage`](https://usage.jdx.dev) spec (`usage.kdl`) that drives shell completions and manpages. Install the `usage` Rust binary once:

```bash
# Homebrew
brew install jdx/tap/usage

# mise
mise use -g usage

# cargo (any OS)
cargo install usage-cli
```

Then eval the completion script for your shell — pick one of:

```bash
# zsh (in .zshrc)
eval "$(usage complete-word --shell zsh -- gmail)"

# bash (in .bashrc)
eval "$(usage complete-word --shell bash -- gmail)"

# fish
usage complete-word --shell fish -- gmail | source
```

Now `gmail <TAB>` autocompletes subcommands and flags. The runtime spec is also available via `gmail --usage-spec` (prints the same KDL to stdout) — useful for one-off `usage` pipelines.

## Env-Driven Config (No `~/.gmail-mcp/` Files Needed)

For deployments where you don't want filesystem state (Docker, Cloud Run, ephemeral CI runners, MCP hosts that spawn from arbitrary CWDs), pass everything via env vars in your host config's `env: {}` block.

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["@george43g/gmail-mcp", "mcp"],
      "env": {
        "GMAIL_OAUTH_KEYS_JSON": "${GMAIL_OAUTH_KEYS_JSON}",
        "GMAIL_CREDENTIALS_JSON": "${GMAIL_CREDENTIALS_JSON}"
      }
    }
  }
}
```

To capture both env vars in one shot:

```bash
gmail account auth deploy --print-json > deploy.env.json
# pipe into a host config, GH Actions repo secret, 1Password item, etc.
```

Three credential sources, first match wins:

| Env var | Use case |
|---|---|
| `GMAIL_CREDENTIALS_JSON` | CI secrets (GH Actions, GitLab), Docker, k8s — paste the JSON |
| `GMAIL_CREDENTIALS_OP` | 1Password CLI — value is `op://Vault/Item/field`, shells to `op read` |
| `GMAIL_CREDENTIALS_PATH` | Explicit credentials file override. Without this env var, named accounts use `~/.gmail-mcp/accounts/<id>/credentials.json`. |

Same pattern for OAuth client keys: `GMAIL_OAUTH_KEYS_JSON` (env) > `GMAIL_OAUTH_PATH` (file).

## Multi-Account

`gmail` supports multiple Gmail accounts per `<configDir>`. Each named account has its own credentials directory; a manifest at `<configDir>/accounts.json` tracks them.

```sh
gmail account                         # interactive CRUD manager
gmail account auth work               # authenticate a new account "work"
gmail account auth personal           # …and another
gmail account list                    # tabular view (status, id, email, scopes, default?)
gmail account check --all --json      # scriptable auth-health check
gmail account use work                # set defaultAccount in the manifest
gmail account current                 # print resolved active account + source
gmail account rename work work-old    # rename an account id + directory
gmail account rm personal             # remove (prompts to confirm; --force to skip)
```

Per-command override (no state mutation):

```sh
gmail --account work search "in:inbox"
gmail -a personal read <messageId>
GMAIL_ACCOUNT=work gmail search "in:inbox"     # env equivalent of -a
```

**Resolution chain (first hit wins):**

1. `--account <id>` CLI flag (per-command)
2. `GMAIL_ACCOUNT` env var
3. `defaultAccount` in `<configDir>/accounts.json`
4. The sole account in the manifest, if there's exactly one
5. Legacy `<configDir>/credentials.json` (auto-migrated to `accounts/default/` on first read)

**File layout:**

```
~/.gmail-mcp/
├── accounts.json                   # manifest
├── gcp-oauth.keys.json             # shared OAuth keys (default)
└── accounts/
    ├── default/credentials.json    # migrated from legacy file on first run
    ├── work/credentials.json
    └── personal/
        ├── credentials.json
        └── gcp-oauth.keys.json     # per-account override (optional)
```

OAuth client keys are resolved per-account first (if `accounts/<id>/gcp-oauth.keys.json` exists), then fall back to the shared `<configDir>/gcp-oauth.keys.json`. Most users keep one Google Cloud project across all Gmail addresses; the per-account override is for CI/multi-tenant deployments that want fully isolated OAuth clients.

**Migration:** on first read for accountId `default`, if the legacy `credentials.json` exists but `accounts/default/credentials.json` does not, the loader copies (not moves) the file — your existing single-account setup keeps working, and a downgrade still finds the legacy file.

**Operator-time account selection in `.mcp.json`:** point separate MCP entries at separate accounts via per-entry env. This is still the simplest way to make multiple accounts available to a host without a stateful `switch_account` call:

```jsonc
{
  "mcpServers": {
    "gmail-work":     { "command": "gmail", "args": ["mcp"], "env": { "GMAIL_ACCOUNT": "work" } },
    "gmail-personal": { "command": "gmail", "args": ["mcp"], "env": { "GMAIL_ACCOUNT": "personal" } }
  }
}
```

Both processes share `~/.gmail-mcp/` and read different per-account directories. Alternative: use distinct `GMAIL_CONFIG_DIR`s if you want fully isolated config trees.

### Switching accounts from inside an MCP session

Two meta-tools let an MCP host (or the model it drives) work with multiple authenticated accounts in a single server process. The MCP only ever operates on **one account at a time** — these tools just let you change which one.

| Tool | Role | Permission |
|---|---|---|
| `list_accounts` | Read. Returns the configured accounts (id, email, scopes, default flag) and which one is currently active. No Gmail API call. | `readOnlyHint: true` — hosts allow freely. |
| `switch_account` | Write. Input `{accountId}`. Loads that account's credentials and swaps the active session for subsequent tool calls. | `destructiveHint: false, idempotentHint: false` — hosts can permission-gate as a state-change. |

Workflow from the model's perspective:

1. Call `list_accounts` to see what's available.
2. Call `switch_account` with the desired `accountId`.
3. All subsequent tool calls (`read_email`, `send_email`, …) hit the new account.

**Important caveat:** the host's cached `tools/list` does NOT auto-refresh on switch. If the new account has narrower scopes than the previous one (e.g. `gmail.readonly` instead of `gmail.modify`), tools that need the missing scope will reject at call-time with the usual re-auth hint. The `switch_account` response surfaces this in its `note` field.

Add a new account from the shell first (`gmail account auth work`) — then it's pickable via `switch_account`. The MCP tools never run the OAuth flow; that always stays a CLI affordance.

## Self-Hosting on a Remote Server

You can run this MCP on a Cloud Run / Fly.io / Pi / VPS and have any MCP host connect over HTTPS. The `gmail mcp --http` mode wraps the MCP in `StreamableHTTPServerTransport` with bearer-token auth.

### 1. Authenticate locally, then ship credentials to the server

Personal Gmail OAuth requires a browser-based flow — there's no headless way to mint new tokens on a server. So: authenticate once on a laptop, then ship the resulting credentials to the server.

```bash
# On laptop (with browser):
gmail account auth deploy --scopes=gmail.modify,gmail.compose --print-json > deploy.json

# Ship deploy.json to the server (rsync, GH Actions secret, 1Password, etc.)
```

### 2. Run the HTTP server

```bash
# On the remote server:
export GMAIL_HTTP_TOKEN=$(openssl rand -hex 32)
export GMAIL_OAUTH_KEYS_JSON='...'        # from deploy.json
export GMAIL_CREDENTIALS_JSON='...'       # from deploy.json
gmail mcp --http --bind 127.0.0.1 --port 8080
```

Endpoints:
- `POST /mcp` — MCP Streamable HTTP, requires `Authorization: Bearer $GMAIL_HTTP_TOKEN`
- `GET /health` — health snapshot, no auth (returns 503 if `unhealthy`)

### 3. Front it with TLS

The server intentionally doesn't terminate TLS. Pick a reverse proxy:

**Caddy** (auto-Let's Encrypt):
```Caddyfile
gmail.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

**Cloudflare Tunnel** (zero config, free):
```bash
cloudflared tunnel --url http://localhost:8080
```

**Cloud Run** — bind `0.0.0.0:$PORT`, set `GMAIL_*` from Secret Manager.

### 4. Point your MCP host at the remote URL

```bash
# Claude Code:
claude mcp add --transport http \
  --url https://gmail.example.com/mcp \
  --header "Authorization: Bearer $GMAIL_HTTP_TOKEN" \
  gmail-remote
```

OpenCode `opencode.json`:
```json
{
  "mcp": {
    "gmail-remote": {
      "type": "remote",
      "url": "https://gmail.example.com/mcp",
      "headers": { "Authorization": "Bearer ${GMAIL_HTTP_TOKEN}" }
    }
  }
}
```

### Alternative: SSH port-forward (no public URL needed)

If you'd rather not expose anything publicly, run the auth locally over an SSH tunnel:

```bash
ssh -L 3000:localhost:3000 your-server
# Then on the server:
gmail account auth work --headless
# Open the printed URL on your laptop browser — the callback tunnels back.
```

## GitHub Actions Recipe

Send email from a workflow without writing OAuth keys to disk:

```yaml
# .github/workflows/notify.yml
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: npm i -g @george43g/gmail-mcp
      - name: Send email
        env:
          GMAIL_OAUTH_KEYS_JSON: ${{ secrets.GMAIL_OAUTH_KEYS_JSON }}
          GMAIL_CREDENTIALS_JSON: ${{ secrets.GMAIL_CREDENTIALS_JSON }}
        run: |
          gmail send \
            -t alerts@example.com \
            -s "Build $GITHUB_RUN_ID succeeded" \
            -b "See $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
```

To populate the secrets:

```bash
gmail account auth ci-sender --scopes=gmail.send --print-json | jq -r .GMAIL_OAUTH_KEYS_JSON \
  | gh secret set GMAIL_OAUTH_KEYS_JSON
gmail account auth ci-sender --scopes=gmail.send --print-json | jq -r .GMAIL_CREDENTIALS_JSON \
  | gh secret set GMAIL_CREDENTIALS_JSON
```

## Available Tools

The server provides the following tools that can be used through Claude Desktop:

### 1. Send Email (`send_email`)

Sends a new email immediately. Supports plain text, HTML, or multipart emails **with optional file attachments**.

Basic Email:
```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting Tomorrow",
  "body": "Hi,\n\nJust a reminder about our meeting tomorrow at 10 AM.\n\nBest regards",
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"],
  "mimeType": "text/plain"
}
```

**Email with Attachments:**
```json
{
  "to": ["recipient@example.com"],
  "subject": "Project Files",
  "body": "Hi,\n\nPlease find the project files attached.\n\nBest regards",
  "attachments": [
    "/path/to/document.pdf",
    "/path/to/spreadsheet.xlsx",
    "/path/to/presentation.pptx"
  ]
}
```

HTML Email Example:
```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting Tomorrow",
  "mimeType": "text/html",
  "body": "<html><body><h1>Meeting Reminder</h1><p>Just a reminder about our <b>meeting tomorrow</b> at 10 AM.</p><p>Best regards</p></body></html>"
}
```

Multipart Email Example (HTML + Plain Text):
```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting Tomorrow",
  "mimeType": "multipart/alternative",
  "body": "Hi,\n\nJust a reminder about our meeting tomorrow at 10 AM.\n\nBest regards",
  "htmlBody": "<html><body><h1>Meeting Reminder</h1><p>Just a reminder about our <b>meeting tomorrow</b> at 10 AM.</p><p>Best regards</p></body></html>"
}
```

### 2. Draft Email (`draft_email`)
Creates a draft email without sending it. **Also supports attachments**.

```json
{
  "to": ["recipient@example.com"],
  "subject": "Draft Report",
  "body": "Here's the draft report for your review.",
  "cc": ["manager@example.com"],
  "attachments": ["/path/to/draft_report.docx"]
}
```

### 3. Read Email (`read_email`)
Retrieves the content of a specific email by its ID. **Now shows enhanced attachment information**.

```json
{
  "messageId": "182ab45cd67ef"
}
```

**Enhanced Response includes attachment details:**
```
Subject: Project Files
From: sender@example.com
To: recipient@example.com
Date: Thu, 19 Jun 2025 10:30:00 -0400

Email body content here...

Attachments (2):
- document.pdf (application/pdf, 245 KB, ID: ANGjdJ9fkTs-i3GCQo5o97f_itG...)
- spreadsheet.xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 89 KB, ID: BWHkeL8gkUt-j4HDRp6o98g_juI...)
```

### 4. **Download Attachment (`download_attachment`)**
**NEW**: Downloads email attachments to your local filesystem.

```json
{
  "messageId": "182ab45cd67ef",
  "attachmentId": "ANGjdJ9fkTs-i3GCQo5o97f_itG...",
  "savePath": "/path/to/downloads",
  "filename": "downloaded_document.pdf"
}
```

Parameters:
- `messageId`: The ID of the email containing the attachment
- `attachmentId`: The attachment ID (shown in enhanced email display)
- `savePath`: Directory to save the file (optional, defaults to current directory)
- `filename`: Custom filename (optional, uses original filename if not provided)

### 5. Search Emails (`search_emails`)
Searches for emails using Gmail search syntax.

```json
{
  "query": "from:sender@example.com after:2024/01/01 has:attachment",
  "maxResults": 10
}
```

### 6. Modify Email (`modify_email`)
Adds or removes labels from emails (move to different folders, archive, etc.).

```json
{
  "messageId": "182ab45cd67ef",
  "addLabelIds": ["IMPORTANT"],
  "removeLabelIds": ["INBOX"]
}
```

### 7. Delete Email (`delete_email`)
Permanently deletes an email.

```json
{
  "messageId": "182ab45cd67ef"
}
```

### 8. List Email Labels (`list_email_labels`)
Retrieves all available Gmail labels.

```json
{}
```

### 9. Create Label (`create_label`)
Creates a new Gmail label.

```json
{
  "name": "Important Projects",
  "messageListVisibility": "show",
  "labelListVisibility": "labelShow"
}
```

### 10. Update Label (`update_label`)
Updates an existing Gmail label.

```json
{
  "id": "Label_1234567890",
  "name": "Urgent Projects",
  "messageListVisibility": "show",
  "labelListVisibility": "labelShow"
}
```

### 11. Delete Label (`delete_label`)
Deletes a Gmail label.

```json
{
  "id": "Label_1234567890"
}
```

### 12. Get or Create Label (`get_or_create_label`)
Gets an existing label by name or creates it if it doesn't exist.

```json
{
  "name": "Project XYZ",
  "messageListVisibility": "show",
  "labelListVisibility": "labelShow"
}
```

### 13. Batch Modify Emails (`batch_modify_emails`)
Modifies labels for multiple emails in efficient batches.

```json
{
  "messageIds": ["182ab45cd67ef", "182ab45cd67eg", "182ab45cd67eh"],
  "addLabelIds": ["IMPORTANT"],
  "removeLabelIds": ["INBOX"],
  "batchSize": 50
}
```

### 14. Batch Delete Emails (`batch_delete_emails`)
Permanently deletes multiple emails in efficient batches.

```json
{
  "messageIds": ["182ab45cd67ef", "182ab45cd67eg", "182ab45cd67eh"],
  "batchSize": 50
}
```

### 15. Create Filter (`create_filter`)
Creates a new Gmail filter with custom criteria and actions.

```json
{
  "criteria": {
    "from": "newsletter@company.com",
    "hasAttachment": false
  },
  "action": {
    "addLabelIds": ["Label_Newsletter"],
    "removeLabelIds": ["INBOX"]
  }
}
```

### 16. List Filters (`list_filters`)
Retrieves all Gmail filters.

```json
{}
```

### 17. Get Filter (`get_filter`)
Gets details of a specific Gmail filter.

```json
{
  "filterId": "ANe1Bmj1234567890"
}
```

### 18. Delete Filter (`delete_filter`)
Deletes a Gmail filter.

```json
{
  "filterId": "ANe1Bmj1234567890"
}
```

### 19. Create Filter from Template (`create_filter_from_template`)
Creates a filter using pre-defined templates for common scenarios.

```json
{
  "template": "fromSender",
  "parameters": {
    "senderEmail": "notifications@github.com",
    "labelIds": ["Label_GitHub"],
    "archive": true
  }
}
```

### 20. Reply All (`reply_all`)
Replies to all recipients of an email. Automatically fetches the original email to build the recipient list and sets proper threading headers (`In-Reply-To`, `References`, `threadId`).

**How it works:**
1. Fetches the original email by `messageId`
2. Builds **To** from the original sender (From header)
3. Builds **CC** from original To + CC, excluding your own email
4. Sets threading headers so the reply lands in the correct thread
5. Sends via the existing `send_email` pipeline (supports attachments, HTML, multipart)

```json
{
  "messageId": "182ab45cd67ef",
  "body": "Thanks for the update, everyone. I'll review and get back to you.",
  "mimeType": "text/plain"
}
```

**With HTML and attachments:**
```json
{
  "messageId": "182ab45cd67ef",
  "body": "Plain text fallback",
  "htmlBody": "<p>Thanks for the update. See attached notes.</p>",
  "mimeType": "multipart/alternative",
  "attachments": ["/path/to/notes.pdf"]
}
```

Parameters:
- `messageId` (required): ID of the email to reply to
- `body` (required): Reply body (plain text, or fallback when using multipart)
- `htmlBody` (optional): HTML version of the reply body
- `mimeType` (optional): `text/plain` (default), `text/html`, or `multipart/alternative`
- `attachments` (optional): Array of file paths to attach

## Filter Management Features

### Filter Criteria

You can create filters based on various criteria:

| Criteria | Example | Description |
|----------|---------|-------------|
| `from` | `"sender@example.com"` | Emails from a specific sender |
| `to` | `"recipient@example.com"` | Emails sent to a specific recipient |
| `subject` | `"Meeting"` | Emails with specific text in subject |
| `query` | `"has:attachment"` | Gmail search query syntax |
| `negatedQuery` | `"spam"` | Text that must NOT be present |
| `hasAttachment` | `true` | Emails with attachments |
| `size` | `10485760` | Email size in bytes |
| `sizeComparison` | `"larger"` | Size comparison (`larger`, `smaller`) |

### Filter Actions

Filters can perform the following actions:

| Action | Example | Description |
|--------|---------|-------------|
| `addLabelIds` | `["IMPORTANT", "Label_Work"]` | Add labels to matching emails |
| `removeLabelIds` | `["INBOX", "UNREAD"]` | Remove labels from matching emails |
| `forward` | `"backup@example.com"` | Forward emails to another address |

### Filter Templates

The server includes pre-built templates for common filtering scenarios:

#### 1. From Sender Template (`fromSender`)
Filters emails from a specific sender and optionally archives them.

```json
{
  "template": "fromSender",
  "parameters": {
    "senderEmail": "newsletter@company.com",
    "labelIds": ["Label_Newsletter"],
    "archive": true
  }
}
```

#### 2. Subject Filter Template (`withSubject`)
Filters emails with specific subject text and optionally marks as read.

```json
{
  "template": "withSubject",
  "parameters": {
    "subjectText": "[URGENT]",
    "labelIds": ["Label_Urgent"],
    "markAsRead": false
  }
}
```

#### 3. Attachment Filter Template (`withAttachments`)
Filters all emails with attachments.

```json
{
  "template": "withAttachments",
  "parameters": {
    "labelIds": ["Label_Attachments"]
  }
}
```

#### 4. Large Email Template (`largeEmails`)
Filters emails larger than a specified size.

```json
{
  "template": "largeEmails",
  "parameters": {
    "sizeInBytes": 10485760,
    "labelIds": ["Label_Large"]
  }
}
```

#### 5. Content Filter Template (`containingText`)
Filters emails containing specific text and optionally marks as important.

```json
{
  "template": "containingText",
  "parameters": {
    "searchText": "invoice",
    "labelIds": ["Label_Finance"],
    "markImportant": true
  }
}
```

#### 6. Mailing List Template (`mailingList`)
Filters mailing list emails and optionally archives them.

```json
{
  "template": "mailingList",
  "parameters": {
    "listIdentifier": "dev-team",
    "labelIds": ["Label_DevTeam"],
    "archive": true
  }
}
```

### Common Filter Examples

Here are some practical filter examples:

**Auto-organize newsletters:**
```json
{
  "criteria": {
    "from": "newsletter@company.com"
  },
  "action": {
    "addLabelIds": ["Label_Newsletter"],
    "removeLabelIds": ["INBOX"]
  }
}
```

**Handle promotional emails:**
```json
{
  "criteria": {
    "query": "unsubscribe OR promotional"
  },
  "action": {
    "addLabelIds": ["Label_Promotions"],
    "removeLabelIds": ["INBOX", "UNREAD"]
  }
}
```

**Priority emails from boss:**
```json
{
  "criteria": {
    "from": "boss@company.com"
  },
  "action": {
    "addLabelIds": ["IMPORTANT", "Label_Boss"]
  }
}
```

**Large attachments:**
```json
{
  "criteria": {
    "size": 10485760,
    "sizeComparison": "larger",
    "hasAttachment": true
  },
  "action": {
    "addLabelIds": ["Label_LargeFiles"]
  }
}
```

## Advanced Search Syntax

The `search_emails` tool supports Gmail's powerful search operators:

| Operator | Example | Description |
|----------|---------|-------------|
| `from:` | `from:john@example.com` | Emails from a specific sender |
| `to:` | `to:mary@example.com` | Emails sent to a specific recipient |
| `subject:` | `subject:"meeting notes"` | Emails with specific text in the subject |
| `has:attachment` | `has:attachment` | Emails with attachments |
| `after:` | `after:2024/01/01` | Emails received after a date |
| `before:` | `before:2024/02/01` | Emails received before a date |
| `is:` | `is:unread` | Emails with a specific state |
| `label:` | `label:work` | Emails with a specific label |

You can combine multiple operators: `from:john@example.com after:2024/01/01 has:attachment`

## Advanced Features

### **Email Attachment Support**

The server provides comprehensive attachment functionality:

- **Sending Attachments**: Include file paths in the `attachments` array when sending or drafting emails
- **Attachment Detection**: Automatically detects MIME types and file sizes
- **Download Capability**: Download any email attachment to your local filesystem
- **Enhanced Display**: View detailed attachment information including filenames, types, sizes, and download IDs
- **Multiple Formats**: Support for all common file types (documents, images, archives, etc.)
- **RFC822 Compliance**: Uses Nodemailer for proper MIME message formatting

**Supported File Types**: All standard file types including PDF, DOCX, XLSX, PPTX, images (PNG, JPG, GIF), archives (ZIP, RAR), and more.

### Email Content Extraction

The server intelligently extracts email content from complex MIME structures:

- Prioritizes plain text content when available
- Falls back to HTML content if plain text is not available
- Handles multi-part MIME messages with nested parts
- **Processes attachments information (filename, type, size, download ID)**
- Preserves original email headers (From, To, Subject, Date)

### International Character Support

The server fully supports non-ASCII characters in email subjects and content, including:
- Turkish, Chinese, Japanese, Korean, and other non-Latin alphabets
- Special characters and symbols
- Proper encoding ensures correct display in email clients

### Comprehensive Label Management

The server provides a complete set of tools for managing Gmail labels:

- **Create Labels**: Create new labels with customizable visibility settings
- **Update Labels**: Rename labels or change their visibility settings
- **Delete Labels**: Remove user-created labels (system labels are protected)
- **Find or Create**: Get a label by name or automatically create it if not found
- **List All Labels**: View all system and user labels with detailed information
- **Label Visibility Options**: Control how labels appear in message and label lists

Label visibility settings include:
- `messageListVisibility`: Controls whether the label appears in the message list (`show` or `hide`)
- `labelListVisibility`: Controls how the label appears in the label list (`labelShow`, `labelShowIfUnread`, or `labelHide`)

These label management features enable sophisticated organization of emails directly through Claude, without needing to switch to the Gmail interface.

### Batch Operations

The server includes efficient batch processing capabilities:

- Process up to 50 emails at once (configurable batch size)
- Automatic chunking of large email sets to avoid API limits
- Detailed success/failure reporting for each operation
- Graceful error handling with individual retries
- Perfect for bulk inbox management and organization tasks

## Security Notes

- OAuth credentials are stored securely in your local environment (`~/.gmail-mcp/`)
- The server uses offline access to maintain persistent authentication
- Never share or commit your credentials to version control
- Regularly review and revoke unused access in your Google Account settings
- Credentials are stored globally but are only accessible by the current user
- **Attachment files are processed locally and never stored permanently by the server**

## Troubleshooting

1. **OAuth Keys Not Found**
   - Make sure `gcp-oauth.keys.json` is in either your current directory or `~/.gmail-mcp/`
   - Check file permissions

2. **Invalid Credentials Format**
   - Ensure your OAuth keys file contains either `web` or `installed` credentials
   - For web applications, verify the redirect URI is correctly configured

3. **Port Already in Use**
   - If port 3000 is already in use, please free it up before running authentication
   - You can find and stop the process using that port

4. **Batch Operation Failures**
   - If batch operations fail, they automatically retry individual items
   - Check the detailed error messages for specific failures
   - Consider reducing the batch size if you encounter rate limiting

5. **Attachment Issues**
   - **File Not Found**: Ensure attachment file paths are correct and accessible
   - **Permission Errors**: Check that the server has read access to attachment files
   - **Size Limits**: Gmail has a 25MB attachment size limit per email
   - **Download Failures**: Verify you have write permissions to the download directory

## Running against fixtures (development)

`GMAIL_FIXTURE_MODE=1` boots the dispatcher against the JSON corpus under `fixtures/gmail/<account>/` instead of going through OAuth. Useful for iterating on the TUI / CLI without real credentials.

```sh
# Run the TUI against fixtures
GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail GMAIL_ACCOUNT=work pnpm dev:tui

# Run the CLI against fixtures (e.g. inspect search results)
node --env-file=.env.test dist/cli/index.js search "in:inbox" --json

# Switch account inside the fixture-backed dispatcher
node --env-file=.env.test dist/cli/index.js --account personal search "in:inbox" --json
```

The shipped corpus is hand-crafted (no real Gmail data is committed). Zod schemas in `src/fixtures/gmail-schemas.ts` validate every fixture file at load time, and a CI guard fails the build if any fixture matches a known-real domain.

End-to-end tests live under `tests/e2e/` and run automatically via `pnpm test:e2e` (also included in `pnpm verify`). They exercise:

- `bootstrapSession` against fixtures
- `list_inbox_threads` → `switch_account` → `list_inbox_threads` (proves the account-switcher contract)
- `sessionEvents.accountChanged` firing on real swaps (and not firing on no-op swaps)
- The built `dist/cli/index.js` binary spawned as a subprocess (matches the published shape)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

**CI requires README updates** — every push to `main` and every PR must include a README.md change (even a version bump or changelog entry). This ensures documentation stays current as the codebase evolves.

To bypass for commits that genuinely don't need a docs update (dependency bumps, CI config changes), include `[skip-readme]` or `[no-readme]` in your commit message or PR title.


## Running evals

The evals package loads an mcp client that then runs the index.ts file, so there is no need to rebuild between tests. You can load environment variables by prefixing the npx command. Full documentation can be found [here](https://www.mcpevals.io/docs).

```bash
OPENAI_API_KEY=your-key  npx mcp-eval src/evals/evals.ts src/index.ts
```

## License

MIT

## Support

If you encounter any issues or have questions, please [file an issue](https://github.com/george43g/gmail-mcp/issues).
