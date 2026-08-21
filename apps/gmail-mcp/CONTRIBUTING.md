# Contributing

Contributions are welcome. Open an issue before starting a large behavioral or architectural change so the scope can be agreed first.

## Development

The published runtime supports Node.js 20.6 or newer. Local pnpm development requires Node.js 22.13 or newer with pnpm 11; CI verifies the Node 20 runtime through npm and the Node 24 runtime through pnpm.

```bash
pnpm install
pnpm verify
```

Keep both lockfiles current when dependencies change:

```bash
pnpm add <package>
npm install --package-lock-only
```

The release tarball bundles the MCP SDK dependency tree because SDK 1.29 still declares a vulnerable Hono adapter range. `npm run package:check` builds an isolated npm staging tree, rewrites only the staged SDK manifest to the tested 2.x adapter range, and verifies that both packages are present. `npm run package:tarball -- --pack-destination <dir>` emits the same inspected artifact. Do not remove this step until the upstream SDK ships a patched range.

Tests live beside source files as `*.test.ts`. Broad changes should include fixture e2e coverage under `tests/e2e/`. Regenerate `usage.kdl` after changing the Commander tree:

```bash
pnpm run gen-usage
```

Do not commit OAuth keys, Gmail credentials, `.env` files, account manifests, logs, or real email content. Use the fixture corpus for tests and screenshots.

## Pull Requests

- Keep commits focused and preserve contributor attribution when porting prior work.
- Run `pnpm verify` and `git diff --check` before submission.
- Update README and screenshots when a user-visible CLI or TUI workflow changes.
- Describe required OAuth scopes and destructive behavior for every new Gmail operation.
