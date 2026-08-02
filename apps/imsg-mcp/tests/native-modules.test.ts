import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Native module compatibility", () => {
  it("should load better-sqlite3 without NODE_MODULE_VERSION mismatch", async () => {
    // This test will fail immediately if better-sqlite3 was compiled for a different Node version
    // Error would be: "was compiled against a different Node.js version using NODE_MODULE_VERSION X"
    const importModule = async () => {
      const Database = (await import("better-sqlite3")).default;
      // Verify we can instantiate (uses :memory: to avoid filesystem)
      const db = new Database(":memory:");
      db.close();
      return true;
    };

    await expect(importModule()).resolves.toBe(true);
  });

  it("should report Node.js version info for debugging", () => {
    // Log version info to help diagnose issues in CI/local environments
    const nodeVersion = process.version;
    const moduleVersion = process.versions.modules;

    console.log(`Node.js version: ${nodeVersion}`);
    console.log(`NODE_MODULE_VERSION: ${moduleVersion}`);

    expect(nodeVersion).toBeDefined();
    expect(moduleVersion).toBeDefined();
  });

  it("should have aligned Node versions when using Volta", () => {
    const isVolta = process.env.VOLTA_HOME || process.execPath.includes(".volta");

    if (!isVolta) {
      console.log("Volta not detected, skipping version alignment check");
      return;
    }

    // Get the Node version that pnpm uses vs shell Node
    const pnpmNodeVersion = process.version; // This test runs under pnpm's Node

    let shellNodeVersion: string;
    try {
      // Get what `node --version` returns in a fresh shell (Volta's default)
      shellNodeVersion = execSync("node --version", {
        encoding: "utf-8",
        env: { ...process.env, PATH: process.env.PATH },
      }).trim();
    } catch {
      console.log("Could not determine shell Node version");
      return;
    }

    console.log(`pnpm Node version: ${pnpmNodeVersion}`);
    console.log(`Shell Node version: ${shellNodeVersion}`);

    // Extract major versions for comparison
    const pnpmMajor = pnpmNodeVersion.match(/v(\d+)/)?.[1];
    const shellMajor = shellNodeVersion.match(/v(\d+)/)?.[1];

    if (pnpmMajor !== shellMajor) {
      console.warn(
        `\n⚠️  Node version mismatch detected!\n` +
          `   pnpm uses: ${pnpmNodeVersion}\n` +
          `   shell uses: ${shellNodeVersion}\n` +
          `   Fix: Run "volta install pnpm" to realign versions\n`,
      );
    }

    // Fail if major versions differ - this WILL cause native module issues
    expect(pnpmMajor).toBe(shellMajor);
  });
});
