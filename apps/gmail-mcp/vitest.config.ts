import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tests/e2e/** is opt-in via `pnpm test:e2e` (separate vitest config that
    // boots the dispatcher against fixture data + spawns the built CLI bin).
    // Default `pnpm test` stays fast — unit + integration tests only.
    exclude: ["dist/**", "node_modules/**", "tests/e2e/**"],
    maxWorkers: process.env.CI ? 2 : undefined,
    // 15s everywhere, not just CI: a local `turbo run test` shares the cores
    // with three sibling suites, which is exactly the loaded condition the CI
    // branch budgeted for — under it the heavy CLI tests (full commander
    // import + spawn paths) deterministically blow a 5s budget while passing
    // solo. Slowness stays visible in durations; flakes don't gate verify.
    testTimeout: 15_000,
  },
});
