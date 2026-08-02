# MCP config-sync tool — feature-absorption inventory & plan

_Status: **DEFERRED / EQStack app candidate.** Prototypes exist and work; a properly built tool will
replace them. This doc is the **absorption inventory**: every useful feature, code pattern, and
hard-won fact from the 2026-07/08 session, recorded so the old code can be deleted with confidence
once the real tool exists. Written 2026-08-02._

## The problem it solves

One machine runs many MCP hosts (Claude Code, Claude Desktop, Codex, Cursor, Warp, opencode…), each
with its own config format, location, and mechanism. Adding/updating a server means N hand-edits that
drift. George already runs a canonical-manifest system in `~/dotfiles/mcp/`; this tool is its
successor — same model, properly engineered (tests, TUI, per-repo scope).

## Source files to absorb (then delete/retire)

| File | What it is | Fate |
|---|---|---|
| `~/dotfiles/mcp/mcpsync.mjs` | Fork-built standalone sync CLI + library (zero-dep, ~440 lines) | Reference only — **delete after absorption** |
| `~/dotfiles/mcp/render.js` | Canonical → per-host renderer (opencode, codex TOML block, claude-desktop) | **Operational** until replaced |
| `~/dotfiles/mcp/status.js` | Read-only drift grid + doctor (symlinks, coverage, secret scan) | **Operational** until replaced |
| `~/dotfiles/mcp/sync.sh` | Claude Code user-scope reconciler via `claude mcp` CLI | **Operational** until replaced |
| `imsg-mcp/scripts/hot-deploy-ext.mjs` | Claude Desktop extension hot-deployer (committed in imsg-mcp) | Stays in imsg-mcp (dev tool) |

## Verified host matrix (2026-07, this machine — load-bearing knowledge)

| Host | Store | Top key | stdio shape | http shape | env key | Notes |
|---|---|---|---|---|---|---|
| Claude Code | CLI / `~/.claude.json` | — | `claude mcp add <n> -e K=V -- cmd args` | `--transport http <n> <url>` (`-H` headers) | `-e` | official CLI; user scope via `--scope user`; `~/.claude.json` is a 93KB state file — never hand-edit |
| Codex | CLI / `~/.codex/config.toml` | `[mcp_servers.<n>]` | `codex mcp add <n> --env K=V -- cmd args` | `--url <url>`; TOML `bearer_token_env_var` | `--env` | **TOML**; no per-project MCP (proven, codex-cli 0.145.0) |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` | `{command,args,env}` | limited | `env` | **no CLI, no `${VAR}` expansion, no secret storage** (that exists only for `.mcpb` extension `user_config`/Keychain); needs full Quit+reopen; per-server log filename = extension `display_name` |
| Cursor | `~/.cursor/mcp.json` (+ `<repo>/.cursor/mcp.json`) | `mcpServers` | `{command,args,env}` | `{type:"http",url}` | `env` | `${VAR}` interpolation works; project scope exists |
| Warp | `~/.warp/.mcp.json` (+ `<repo>/.warp/.mcp.json`) | `mcpServers` | `{command,args,env}` | `{type:"http",url,headers}` | `env` | **IS file-automatable** (early report said UI-only — wrong); on this machine it's a symlink chain into dotfiles |
| opencode | `~/.config/opencode/opencode.json` | **`mcp`** | `{type:"local",command:[cmd,…args],environment,enabled}` | `{type:"remote",url,enabled}` | **`environment`** | the schema outlier — command is ONE array |
| ChatGPT desktop | remote account connectors | — | — | — | — | **NOT file-automatable** (verified) — omit by design |

**Convergence insight:** `.mcp.json` + `mcpServers` is the de-facto shared canonical — Warp, Cursor,
and Desktop all speak it natively, which is why the dotfiles symlink-chain approach works for two of
them with zero rendering.

## Feature inventory — `mcpsync.mjs` (the good bits)

- **Canonical schema + `normalize()`**: any host/user shape → `{transport: stdio|http|sse, command,
  args, env, url, headers}`; absorbs opencode's `environment` and `type:"sse"`.
- **Adapter interface** (the core design): `{id, label, kind: "file"|"cli", configPath|bin, restart,
  detect(), read(), toNative(), writeServer(name, srv, {dryRun}), removeServer()}`. Two factories:
  - `jsonMcpServersAdapter` (Desktop/Cursor/Warp): merges ONLY `mcpServers.<name>`, never touches
    other keys; **timestamped backup before every write**; **symlink write-through detection**
    (`lstat` + `realpathSync`, surfaces the resolved target in output — critical for the dotfiles
    symlink chains).
  - `cliAdapter` (Claude Code/Codex): builds the official add/remove command lines; `detect()` via
    `<bin> mcp --help`; dry-run prints the exact command instead of running it.
- **Per-host restart hints**, aggregated and printed once after `apply`.
- **Commands**: `doctor` (host presence + paths) · `list` (servers×hosts grid) · `import --from
  <host>` (host → canonical) · `apply [--to host|all] [--only a,b] [--dry-run]` · `add`/`remove` ·
  `sync`.
- **Library export for self-configuring tools**: `applyServer(hostId, name, server)` — the
  "an MCP installs itself into your hosts" story (supersedes the earlier "register-mcp mode on
  hot-deploy-ext" idea).
- **Known weaknesses (do NOT copy)**: CLI-host `read()` heuristically parses `mcp list` stdout and
  picks up noise tokens — the real tool must parse `~/.claude.json` / `config.toml` directly;
  `normalize()` drops opencode's `enabled:false` state; no `--scope project` yet.

## Feature inventory — dotfiles `render.js` / `status.js` / `sync.sh`

- **Canonical-source model**: `shell/.mcp.json` holds `${VAR}` placeholders ONLY — secrets never at
  rest in any config. Fan-out is render (file hosts) + reconcile (CLI hosts) + symlink (hosts that
  natively read `.mcp.json`).
- **Codex managed TOML block** between `# >>> dotfiles-mcp` / `# <<< dotfiles-mcp` markers; servers
  defined OUTSIDE the block are skipped (duplicate TOML tables are invalid; preserves legacy
  entries); Bearer-`${VAR}` headers become `bearer_token_env_var`; env passthrough → `env_vars`.
- **Claude Desktop adapter** (added this session): Desktop can't expand `${VAR}` and launches from
  the GUI env, so each server is wrapped `$SHELL -lc '…'` with `\ " \`` escaped but `$` left ACTIVE
  (placeholders resolve in the login shell at launch); remote servers bridged via `npx mcp-remote`
  (Desktop `mcpServers` is stdio-only); `_mcpManagedByDotfiles` top-level array tracks the managed
  set so manual/per-repo entries (e.g. `imsg-mcp`) survive re-renders; backup before write.
  **Proven end-to-end**: a server launched through the generated wrapper serves `initialize` and
  stays connected.
- **`sync.sh` reconcile pattern** for Claude Code: remove extraneous → add missing → remove+re-add on
  definition drift; `${VAR}` argv passed literally (python subprocess, no shell expansion).
- **`status.js` doctor**: servers×hosts drift grid; symlink-chain asserts; coverage per host; and a
  **redacted plaintext-secret scanner** with the tuned rules: known token shapes (`sk-`, `gh?_`,
  `github_pat_`, `xox?-`, `AIza…`, `ctx7sk…`), values following secret-named flags in `args`
  (`--api-key <X>`), secret-named fields — while EXCLUDING `${VAR}`/`{env:VAR}` placeholders,
  `SCREAMING_SNAKE_CASE` values (env-var name references), and `*_env_var`/`env_vars` fields (they
  hold names, not values). Deliberately NOT generic entropy scanning (false-positives on UUIDs).
  This scan found a real leak: **the context7 API key in cleartext in `~/.codex/config.toml`**
  (legacy, outside the managed block) — rotate + `${CONTEXT7_API_KEY}` it (dotfiles P7).

## Design rules for the real tool

1. Canonical source of truth with `${VAR}` secret indirection everywhere; per-machine overrides for
   absolute paths (a mise node path doesn't port between machines).
2. Prefer official CLIs (Claude Code, Codex); file-merge the rest; never touch non-MCP keys;
   timestamped backups; dry-run as the default posture.
3. Two scopes: global + per-repo (`<repo>/.mcp.json` canonical; `.cursor/`/`.warp/` symlinks;
   opencode `mcp` key generated — exactly George's existing per-repo convention).
4. Surface symlink write-through explicitly; assert expected chains (doctor).
5. Deferred UX: Ink TUI grid (toggle server×host cells), `import` fidelity from CLI hosts,
   secret-store helpers (chmod-600 store + rotation nudges).

## Related deferred items swept into this plan

- `register-mcp` mode for `hot-deploy-ext.mjs` → superseded by `applyServer()` above.
- "Package mise with the extension" → rejected (mise is a dev-time version manager; at runtime you
  need one pinned ABI). The distribution answer is bun `type:binary` — see
  [`../CLAUDE_DESKTOP_AND_ONLINE_MCP.md`](../CLAUDE_DESKTOP_AND_ONLINE_MCP.md).
