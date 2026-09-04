# Contributing to imsg-mcp

Thanks for considering a contribution! This document covers how to get a local
dev environment running, how tests work, and what we look for in PRs.

## Quick start

```bash
git clone https://github.com/george43g/imsg-mcp.git
cd imsg-mcp
pnpm install        # also generates synthetic test fixtures + builds
pnpm test           # 170+ tests should pass against the fixture DB
pnpm typecheck
```

The `pnpm install` step runs `pnpm prepare`, which generates a small
**synthetic SQLite fixture** (`fixtures/`) on your machine. **No real iMessage
data is ever committed to this repo** — the fixture is built deterministically
from a seeded RNG and contains only lorem-ipsum content with phone numbers in
the `+1-555-01xx` fictional reserved range.

## Running locally against your real Mac data

If you're on macOS and have granted Full Disk Access to your terminal, you
can run the MCP/TUI/CLI against your actual `~/Library/Messages/chat.db`:

```bash
pnpm tui            # the read-only TUI
pnpm mcp            # the stdio MCP server
pnpm cli            # the interactive CLI
```

These read paths from `.env.local` (machine-specific, gitignored).

## Tests

- `pnpm test` — full Vitest suite against synthetic fixtures
- `pnpm test:no-native` — same, with the Rust native module disabled
- `pnpm test:rust` — Cargo unit tests inside `native/`
- `pnpm exec tsx scripts/stress-mcp.ts .env.test` — end-to-end stress harness

All tests must pass before a PR can land. New behavior should come with a
regression test.

## Code style

- TypeScript with strict mode + Biome lint (`pnpm lint`)
- Rust formatted with `rustfmt` (run automatically on `cargo build`)
- Commit messages: short imperative subject + body when context helps
- One feature per PR; don't bundle unrelated changes

## Architecture

This is the EQStack monorepo (pnpm workspaces + Turborepo); the imsg app lives in
**`apps/imsg-mcp/`** and the paths below are relative to it. Root `pnpm build/test/lint/typecheck`
fan out via turbo.

- `src/index.ts` — MCP stdio server + tool definitions
- `src/imessage-db.ts` — SQLite reader for chat.db
- `src/tui/` — Ink/React terminal UI
- `src/watchdog.ts` — self-healing event-loop / memory monitor
- `src/shutdown.ts` — central cleanup registry + signal handling
- `native/` — optional Rust napi-rs module for blob-parsing acceleration
- `fixtures/` — synthetic test data (gitignored, generated on `pnpm install`)

See `apps/imsg-mcp/AGENTS.md` for the deeper internal guide (the paths above are
relative to that directory), and the root `AGENTS.md` for repo-wide rules.

## Reporting issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For security issues
please follow the process in [`SECURITY.md`](SECURITY.md) instead of opening
a public issue.

## License

By contributing, you agree your contributions are licensed under the MIT
license. See [`LICENSE`](LICENSE).
