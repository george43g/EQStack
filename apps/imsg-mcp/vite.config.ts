import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "better-sqlite3",
  "bplist-parser",
  "commander",
  "react",
  "react/jsx-runtime",
  "ink",
  "@inkjs/ui",
  "fullscreen-ink",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/server/index.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "@modelcontextprotocol/sdk/types.js",
  "zod",
];

export default defineConfig({
  // Single source of truth for the app version: package.json (bumped by
  // semantic-release). Statically replaced at build/test time — never
  // hardcode a version in src/.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "node22",
    lib: {
      entry: {
        index: "src/index.ts",
        cli: "src/cli.ts",
        tui: "src/tui/index.tsx",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: nodeExternals,
      output: {
        banner: (chunk) => (chunk.isEntry ? "#!/usr/bin/env node" : ""),
      },
    },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.tsx"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
