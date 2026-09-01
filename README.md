# EQStack

Monorepo for the **EQStack** tool suite.

| App | What it is |
|---|---|
| [**imsg-mcp**](apps/imsg-mcp/README.md) | iMessage / SMS MCP server, CLI, and TUI for macOS — lets AI agents text humans, fetch conversation history, and stream-export entire chats. Published on npm as [`imsg-mcp`](https://www.npmjs.com/package/imsg-mcp). |
| [**telephony-mcp**](apps/telephony-mcp/README.md) | Local-first MCP server + telephony gateway — lets an AI agent place a real, interruptible phone call to an allowlisted person over Twilio ConversationRelay with ElevenLabs voice, driven either by an LLM or directly by the MCP host ("walkie-talkie" mode). Private (not published). |

## Layout

- `apps/` — shippable applications (`apps/imsg-mcp`, `apps/telephony-mcp`).
- `packages/` — shared internal packages (`@eqstack/*`, private).
- `docs/` — repo-level docs: [`docs/STATUS.md`](docs/STATUS.md), [`docs/MONOREPO_MIGRATION.md`](docs/MONOREPO_MIGRATION.md). App-specific docs live in `apps/<app>/docs/`.

## Development

pnpm workspaces + [Turborepo](https://turborepo.dev). Node ≥ 24, pnpm 11.

```bash
pnpm install
pnpm build        # turbo run build
pnpm test         # turbo run test
pnpm lint && pnpm typecheck
```

Root scripts fan out via turbo; app-specific entry points (`pnpm mcp`, `pnpm tui`, `pnpm doctor`, …) delegate into `apps/imsg-mcp`. See [`apps/imsg-mcp/README.md`](apps/imsg-mcp/README.md) for the product docs and [`AGENTS.md`](AGENTS.md) for the agent guide.
