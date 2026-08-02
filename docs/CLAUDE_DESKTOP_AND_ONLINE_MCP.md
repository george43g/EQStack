# Claude Desktop install, distribution & online-MCP exposure

_Findings + decisions from the 2026-07/08 debugging session. Self-contained handoff._

## TL;DR

- **iMessage works in Claude Desktop right now** — via a **manual `mcpServers` entry that runs on system node**, NOT the `.mcpb` extension.
- **The `.mcpb` `type:node` extension is a dead end on Desktop** (proven): Claude Desktop runs it on **Electron's node (abi 146)**, which has **no working in-process SQLite** — better-sqlite3 has no Electron prebuild and `node:sqlite` isn't compiled into Electron. First `chat.db` access → silent crash right after `initialize`.
- **Distribution answer for other users: own the runtime** → ship a **`type:binary` mcpb built with `bun build --compile`** (uses `bun:sqlite`, proven working). Not `type:node`.
- **imsg is stdio-only.** To expose it to online agents (claude.ai etc.), add a **StreamableHTTP transport** (the SDK already ships it) and run the Mac as the backend behind a tunnel + OAuth.

## 1. Why the `.mcpb` extension crashes in Claude Desktop (root cause, proven)

Runtime fingerprint captured from a real Desktop launch (`~/.imsg-mcp/runtime-fingerprint.json`):

```
execPath: …/Claude Helper (Plugin).app/…/Claude Helper (Plugin)
node: v24.18.0   abi: 146   electron: 42.7.0   detectedElectron: true
```

- Desktop launches `.mcpb` `type:node` servers with **its bundled Electron node** (via `ELECTRON_RUN_AS_NODE`, where `process.versions.electron` is empty — detect it by `ELECTRON_RUN_AS_NODE` + execPath instead).
- **better-sqlite3**: no prebuilt binary for Electron abi 146; loading an abi-mismatched `.node` hard-crashes (segfault, not a catchable throw) — dies before any log line.
- **node:sqlite**: not compiled into Electron 42 → the fallback throws too.
- Net: **no in-process SQLite engine exists on that runtime.** Desktop also swallows the child's stderr, which is why it looked like a silent disconnect for so long. (The per-server log is `~/Library/Logs/Claude/mcp-server-<display_name>.log` — note it's keyed by **display_name**, so renaming the extension changes the log filename.)

Verified counter-evidence: the **exact same build runs perfectly on system node** (better-sqlite3 abi 137) and under **forced `node:sqlite`** — so the code is fine; only Desktop's Electron runtime is the problem.

## 2. The working setup (what's live now)

Manual entry in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
"mcpServers": {
  "imsg-mcp": {
    "command": "/Users/george/.local/share/mise/installs/node/24.15.0/bin/node", // system node, abi 137
    "args": ["/Users/george/repos/imsg-mcp/dist/cli.js", "mcp"],
    "env": { "HOME": "/Users/george" }
  }
}
```

- Requires a **full Quit + reopen** of Claude Desktop to take effect (manual config isn't hot-reloaded).
- Needs **Full Disk Access for Claude Desktop.app** to read messages once connected.
- Dev loop: edit → `pnpm build` → restart Desktop (points at the repo's `dist/`, no repack).
- **Secrets note:** imsg needs no secret (local `chat.db`), so the entry is a plain command. Desktop's manual `mcpServers` does NOT expand `${VAR}` and has no secure storage — that's unique to this host. Clean auth in Desktop only exists for **Extensions/Connectors** (settings-page `sensitive` fields → Keychain), which the `.mcpb` config page uses. Other hosts (Claude Code/Codex/opencode/Cursor/Warp) each reference env vars natively.
- Undo: remove the `mcpServers.imsg-mcp` block; backups exist at `claude_desktop_config.json.bak.*`.

## 3. Where the session's changes landed

Released as **1.19.1** (`bcbfcf4`): node:sqlite fallback + stderr observability + packaging +
branding. Helps CLI/TUI and non-Electron hosts; it does **not** rescue the Desktop `.mcpb` (Electron
has no engine at all). Landed after it (→ **1.19.2**):

- `src/sqlite.ts` — Electron-runtime detection (`ELECTRON_RUN_AS_NODE` + execPath; note
  `process.versions.electron` is EMPTY under `ELECTRON_RUN_AS_NODE`), `node:sqlite` presence
  validation, and the `~/.imsg-mcp/runtime-fingerprint.json` dump — which now also records the
  resolved **`engine` / `engineError`** (home-anchored, survives segfaults and swallowed stderr) and
  is **skipped under Vitest** so test runs can't clobber the last host diagnostic.
- `scripts/hot-deploy-ext.mjs` — dev tool: deploy a built extension into Claude Desktop's
  installed-extension dir without a GUI reinstall (`--from <mcpb>`, `--list`; syncs
  dist/native/manifest/package.json/icon/assets; `--full` adds node_modules).
- `manifest.json` — `display_name: "EQStack — Messages MCP"` (suite name decided; em dash rather
  than a colon because Desktop derives the per-server log filename from `display_name`).
- The fork-built `mcpsync.mjs` cross-host sync prototype was **relocated to `~/dotfiles/mcp/`** and
  is slated for replacement by a properly built tool — feature-absorption inventory:
  [`plans/mcp-config-sync-tool.md`](plans/mcp-config-sync-tool.md).

## 4. Distribution options for end-users (the real decision)

`.mcpb type:node` is out (forced onto Electron). Ranked:

1. **Bun `type:binary` mcpb** — `bun build --compile` → single per-arch binary embedding bun + `bun:sqlite` (proven working, blob-clean). Owns the runtime; no ABI/prebuild games. ~50-110 MB/arch. **Recommended.** Requires a small `bun:sqlite` adapter in `src/sqlite.ts` (mirrors the existing node:sqlite adapter; bun provides neither better-sqlite3 nor node:sqlite).
2. **`type:binary` with a bundled node** that has in-process SQLite — heavier, and node:sqlite is still experimental.
3. **Documented manual `mcpServers`** (what George uses) — power-user only; needs node + repo/npm install.
4. **`sqlite3` CLI subprocess** (what Anthropic's own iMessage extension does) — works on any runtime, but `sqlite3 -json` mangles BLOBs, which imsg needs for `attributedBody`/edit-history. Not a clean fit.

## 5. Online / remote MCP exposure (George's proxy idea) — DEFERRED, but well-shaped

Goal: let claude.ai and other online agents use imsg via an MCP **URL** with OAuth.

Hard constraint: imsg must read `chat.db` + run `osascript` **on the Mac**. So **the Mac is always the backend** — you can't fully move it to a server. The realistic architecture:

1. **Add a StreamableHTTP transport** to imsg (`imsg mcp --http --port N`). The SDK already ships `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk/.../server/streamableHttp.js`) — this is a **small feature**, not a rewrite (stdio stays the default).
2. **Run it on the Mac**, expose via a secure tunnel — **Tailscale** (private, simplest) or **cloudflared** (public URL). An RPi/Docker box can host the tunnel/reverse-proxy + OAuth layer, forwarding to the Mac.
3. **Wrap with OAuth** (the online-connector requirement). A thin proxy (RPi/Cloudflare Worker) does token auth → forwards to the Mac's StreamableHTTP endpoint.

Not recommended: **mirroring `chat.db` to a server + reverse-osascript** — high complexity/fragility for no gain over Mac-as-backend + tunnel. **Jailbroken iPhone**: deeper access but a separate, large rabbit hole; the Mac `chat.db` is already the richest, most stable source.

**Roadmap item:** "imsg as a remote MCP" = StreamableHTTP transport + tunnel + OAuth proxy. Modest and mostly infra.

## 6. Related: cross-host MCP fleet management (in `~/dotfiles`, not this repo)

Separate side-project that grew this session. George's `~/dotfiles/mcp/` renders one canonical `shell/.mcp.json` to every host. Added this session:
- **`mcp/render.js`** — new **Claude Desktop adapter** (login-shell `${VAR}` wrap, `mcp-remote` bridge, `_mcpManagedByDotfiles` marker preserves manual/per-repo entries).
- **`mcp/status.js`** — drift grid + `doctor` (symlink checks + redacted plaintext-secret scan). Surfaced a real leak: **the `context7` API key is in cleartext in `~/.codex/config.toml`** (args, `--api-key`, legacy/outside the managed block — the P7 item). Rotate it and move to `${CONTEXT7_API_KEY}`.
- `make mcp-status` / `make mcp-doctor` added.
