// Separate vitest config for the e2e suite. Picks up only tests/e2e/**.test.ts.
// The root vitest.config.ts excludes this directory so the default `pnpm test`
// stays fast — opt into e2e via `pnpm test:e2e` (or `pnpm verify`).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    root: __dirname,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: path.join(__dirname, "setup.ts"),
  },
});
