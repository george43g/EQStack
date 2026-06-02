# tmux MCP wiring (Claude Code)

Two tmux MCP server implementations are already on disk locally but
neither is wired into Claude Code as an active MCP server. This doc is
the operator-facing recipe — apply the JSON block below to your
`~/.claude.json` and restart Claude Code, then both servers' tools
appear in the model's tool list (as `mcp__tmux-rust__*` and
`mcp__tmux__*`) and the benchmark harness in
[`scripts/bench-tmux-mcp.ts`](../scripts/bench-tmux-mcp.ts) can compare
them.

## What's on disk today

| Server | Binary | Source | Runtime |
|---|---|---|---|
| `tmux-mcp-rs` | `/opt/homebrew/bin/tmux-mcp-rs` | `bnomei/homebrew-tmux-mcp` (formula) | Single Rust binary, 7.7 MB |
| `tmux-mcp` | `~/.npm/_npx/<hash>/node_modules/.bin/tmux-mcp` | `nickfedirko/tmux-mcp` (npm) | Node ≥ 18 |

Verify:

```sh
which tmux-mcp-rs && tmux-mcp-rs --version
ls ~/.npm/_npx/*/node_modules/tmux-mcp/package.json 2>/dev/null \
  || echo "(npx cache miss; first npx call will download)"
```

If either is missing:

```sh
# Rust (preferred for speed)
brew tap bnomei/tmux-mcp
brew install tmux-mcp-rs

# Node (warms the npx cache so the JSON block below works offline next time)
npx -y tmux-mcp --help >/dev/null
```

## Wiring both into `~/.claude.json`

Open `~/.claude.json`, locate the `mcpServers` object, and add:

```jsonc
{
  "mcpServers": {
    // … existing entries …

    "tmux-rust": {
      "command": "/opt/homebrew/bin/tmux-mcp-rs",
      "args": [
        "--shell-type", "zsh",
        "--socket", "/tmp/tmux-rust.sock"
      ]
    },

    "tmux": {
      "command": "npx",
      "args": ["-y", "tmux-mcp", "--shell-type=zsh", "--socket=/tmp/tmux-node.sock"]
    }
  }
}
```

Why separate sockets: running both servers in parallel against the
default tmux socket (`/tmp/tmux-${UID}/default`) means each gets a
different view of the same world and the benchmark conflates server
overhead with shared-state contention. Per-server sockets give each
its own isolated tmux server process — clean A/B.

Adjust `--shell-type` to match your default (`bash` / `zsh` / `fish`).

## Apply

```sh
# 1. Quit any running Claude Code instance.
# 2. Edit ~/.claude.json with the block above.
# 3. Re-open Claude Code in this repo.
# 4. Verify both servers appear:
#    The next session's ToolSearch should return
#    mcp__tmux-rust__* and mcp__tmux__* tools.
```

## Next steps

Once both are visible, run:

```sh
pnpm tsx scripts/bench-tmux-mcp.ts
```

The driver in [`scripts/bench-tmux-mcp.ts`](../scripts/bench-tmux-mcp.ts)
runs the metric suite documented in
[`docs/tmux-mcp-bench.md`](./tmux-mcp-bench.md) against each server and
fills in the comparison table.

## Cleanup / rollback

To stop running both:

```sh
# Remove the two entries from ~/.claude.json mcpServers, restart Claude
# Code. The binaries stay on disk but no longer spawn.

# Or kill the sockets if you ever want a clean slate without restarting:
rm -f /tmp/tmux-rust.sock /tmp/tmux-node.sock
```

## Why this isn't fully automated

Claude Code reads `~/.claude.json` at startup. The MCP server list
can't be hot-mutated mid-session — the running model has a frozen view
of the tool surface. So this doc trades a one-time manual edit for the
ability to compare both implementations without spinning up two
separate Claude Code sessions.
