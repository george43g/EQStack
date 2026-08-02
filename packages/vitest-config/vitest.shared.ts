import type { ViteUserConfig } from "vitest/config";

/**
 * Shared Vitest test options for EQStack workspace packages.
 *
 * Spread into each package's config and override as needed:
 *
 *   import { sharedTest } from "@eqstack/vitest-config";
 *   export default defineConfig({ test: { ...sharedTest, include: [...] } });
 */
export const sharedTest: NonNullable<ViteUserConfig["test"]> = {
  globals: true,
  environment: "node",
  include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  exclude: ["**/node_modules/**", "**/dist/**", "**/.turbo/**"],
};
