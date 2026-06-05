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
      "args": ["--shell-type", "zsh"]
    }
  }
}
```

**The watch-along UX is the reason we drop the explicit `--socket`.**
`tmux-mcp-rs` accepts `--socket <path>` and we could isolate its
sessions on `/tmp/tmux-rust.sock`, but then attaching from a second
shell requires the long form `tmux -S /tmp/tmux-rust.sock attach -t
<name>` — easy to forget. Letting the MCP fall through to tmux's
default socket (`/tmp/tmux-<uid>/default` on Linux,
`/private/tmp/tmux-<uid>/default` on macOS) means a plain
`tmux attach -t <name>` works from any shell. Cost: the agent's
sessions share the daemon with whatever tmux work you already have
running. Mitigation: the agent uses uniquely-named sessions, so name
collisions are extremely unlikely.

**Why we dropped the Node `tmux` MCP entirely:** the benchmark in
[`docs/tmux-mcp-bench.md`](./tmux-mcp-bench.md) showed `tmux-mcp-rs`
beats `tmux-mcp` (Node) by 59× on cold start, 16× on RSS, and 4× on
tool surface (55 vs 13 tools, including `send-keys`, buffer ops, and
layout controls the Node version lacks). Per-call latency is roughly
even. Net: `tmux-mcp-rs` is the right default; keep `tmux` in the
wiring only if you specifically need its different stable interface.

## Watch the agent drive tmux

After applying the wiring above and restarting Claude Code, the
rust MCP creates sessions on your default tmux socket. From any
shell:

```sh
tmux list-sessions               # see the sessions the agent is using
tmux attach -t <name>            # attach read-only watchers via tmux's
                                 # multi-client model
```

To stay strictly read-only (avoid accidentally sending input):

```sh
tmux attach -t <name> -r         # `-r` = read-only client
```

If you prefer keeping the agent's sessions on a dedicated socket
(say you want to keep your main tmux server pristine), put
`--socket /tmp/tmux-rust.sock` back in the args and attach with
`tmux -S /tmp/tmux-rust.sock attach -t <name>`.

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
