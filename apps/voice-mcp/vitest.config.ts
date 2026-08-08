import { sharedTest } from "@eqstack/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    ...sharedTest,
    // Serialize DB-touching suites; each test uses its own temp state dir.
    pool: "forks",
  },
});
