import { sharedTest } from "@eqstack/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { ...sharedTest },
});
