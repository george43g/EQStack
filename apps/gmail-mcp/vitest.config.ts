import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tests/e2e/** is opt-in via `pnpm test:e2e` (separate vitest config that
    // boots the dispatcher against fixture data + spawns the built CLI bin).
    // Default `pnpm test` stays fast — unit + integration tests only.
    exclude: ["dist/**", "node_modules/**", "tests/e2e/**"],
    maxWorkers: process.env.CI ? 2 : undefined,
    testTimeout: process.env.CI ? 15_000 : 5_000,
  },
});
