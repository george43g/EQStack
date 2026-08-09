#!/usr/bin/env node
/**
 * README drift guard (CI only — not part of `pnpm lint` to keep lint fast).
 *
 * Fails if a tool exported in src/mcp-tools.ts (TOOLS array) is missing from
 * README.md. One direction only: README may document extras, but every
 * shipped tool must appear as a backticked `tool_name` somewhere in README.
 * Dev-only tools (DEV_TOOL_NAMES — hidden from tools/list for end users)
 * are exempt.
 *
 * Zero-dep: parses the TypeScript source with regexes; sanity-checks the
 * extraction so a refactor of mcp-tools.ts breaks the guard loudly instead
 * of silently passing.
 *
 * Usage: node scripts/check-readme-tools.mjs   (cwd-independent)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(appDir, "src", "mcp-tools.ts"), "utf8");
const readme = readFileSync(join(appDir, "README.md"), "utf8");

// Minimum plausible tool count — if extraction finds fewer, the regexes are
// stale (mcp-tools.ts was refactored) and the guard must fail, not pass.
const MIN_EXPECTED_TOOLS = 15;

const toolsBlock = src.match(/export const TOOLS: Tool\[\] = \[([\s\S]*?)\n\];/);
if (!toolsBlock) {
  console.error("check-readme-tools: could not locate `export const TOOLS: Tool[] = [` block");
  console.error("in src/mcp-tools.ts — update the extraction in this script.");
  process.exit(1);
}
// Tool objects sit at one indent level: `    name: "tool_name",`
const toolNames = [...toolsBlock[1].matchAll(/^ {4}name: "([a-z0-9_]+)",$/gm)].map((m) => m[1]);
if (toolNames.length < MIN_EXPECTED_TOOLS) {
  console.error(
    `check-readme-tools: extracted only ${toolNames.length} tool names (expected >= ${MIN_EXPECTED_TOOLS}).`,
  );
  console.error("The TOOLS array layout in src/mcp-tools.ts probably changed — fix this script.");
  process.exit(1);
}

const devBlock = src.match(/export const DEV_TOOL_NAMES = new Set<ToolName>\(\[([\s\S]*?)\]\)/);
if (!devBlock) {
  console.error("check-readme-tools: could not locate DEV_TOOL_NAMES block in src/mcp-tools.ts");
  process.exit(1);
}
const devNames = new Set([...devBlock[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));

const publicTools = toolNames.filter((n) => !devNames.has(n));
const missing = publicTools.filter((n) => !readme.includes(`\`${n}\``));

console.log(
  `check-readme-tools: ${toolNames.length} tools in mcp-tools.ts ` +
    `(${publicTools.length} public, ${devNames.size} dev-only exempt)`,
);
if (missing.length > 0) {
  console.error("\nMissing from README.md tool table:");
  for (const n of missing) console.error(`  - \`${n}\``);
  console.error("\nAdd the tool(s) to the MCP tools table in apps/imsg-mcp/README.md.");
  process.exit(1);
}
console.log("check-readme-tools: OK — every public tool is documented in README.md");
