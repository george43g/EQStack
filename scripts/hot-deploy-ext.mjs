#!/usr/bin/env node
/**
 * Hot-deploy a built MCP extension straight into Claude Desktop's installed
 * extension directory — no GUI reinstall. Tightens the build→test loop while
 * debugging a `.mcpb`/`.dxt`.
 *
 * Usage:
 *   node scripts/hot-deploy-ext.mjs                 # deploy this repo's build to the matching installed ext
 *   node scripts/hot-deploy-ext.mjs --from <a.mcpb> # deploy from a packed .mcpb/.dxt (a zip) instead
 *   node scripts/hot-deploy-ext.mjs --full          # also sync node_modules (slow; usually unnecessary)
 *   node scripts/hot-deploy-ext.mjs --list          # list installed extensions and exit
 *
 * How it matches: reads the SOURCE manifest.json `name`, then finds the
 * Claude-installed extension dir whose manifest.json `name` matches. Generalises
 * to any extension — nothing here is imsg-specific.
 *
 * After deploying, reload the extension in Claude Desktop (toggle it off/on in
 * Settings ▸ Extensions, or fully Quit + reopen) so the new files are read.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const EXT_ROOT = join(homedir(), "Library", "Application Support", "Claude", "Claude Extensions");
if (!existsSync(EXT_ROOT)) {
  console.error(`✗ Claude Extensions dir not found: ${EXT_ROOT}\n  Is Claude Desktop installed?`);
  process.exit(1);
}

function installedExtensions() {
  return readdirSync(EXT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const mf = join(EXT_ROOT, d.name, "manifest.json");
      let manifest = null;
      try {
        manifest = JSON.parse(readFileSync(mf, "utf8"));
      } catch {}
      return { id: d.name, dir: join(EXT_ROOT, d.name), manifest };
    })
    .filter((e) => e.manifest);
}

if (has("--list")) {
  for (const e of installedExtensions()) {
    console.log(
      `${e.id}\n    name=${e.manifest.name}  display=${e.manifest.display_name ?? "-"}  v${e.manifest.version}`,
    );
  }
  process.exit(0);
}

// ── Resolve the SOURCE (this repo's build, or an extracted .mcpb/.dxt) ──
const repoRoot = process.cwd();
let sourceDir;
let cleanup = null;
const from = val("--from");
if (from) {
  if (!existsSync(from)) {
    console.error(`✗ --from archive not found: ${from}`);
    process.exit(1);
  }
  const tmp = mkdtempSync(join(tmpdir(), "hot-deploy-"));
  cleanup = () => rmSync(tmp, { recursive: true, force: true });
  execFileSync("unzip", ["-q", "-o", from, "-d", tmp]);
  sourceDir = tmp;
} else {
  sourceDir = repoRoot;
}

const srcManifestPath = join(sourceDir, "manifest.json");
if (!existsSync(srcManifestPath)) {
  console.error(
    `✗ No manifest.json in source (${sourceDir}). Build first (pnpm build) or pass --from <archive>.`,
  );
  cleanup?.();
  process.exit(1);
}
const srcManifest = JSON.parse(readFileSync(srcManifestPath, "utf8"));
if (!existsSync(join(sourceDir, "dist"))) {
  console.error(`✗ No dist/ in source (${sourceDir}). Run 'pnpm build' first.`);
  cleanup?.();
  process.exit(1);
}

// ── Match the installed extension by manifest name ──
const explicitId = val("--ext-id");
const candidates = installedExtensions();
const target = explicitId
  ? candidates.find((e) => e.id === explicitId)
  : candidates.find((e) => e.manifest.name === srcManifest.name);
if (!target) {
  console.error(
    `✗ No installed extension matches source name "${srcManifest.name}".\n` +
      `  Install it once via the GUI so the target dir exists, or pass --ext-id. Installed:\n` +
      candidates.map((e) => `    ${e.id} (name=${e.manifest.name})`).join("\n"),
  );
  cleanup?.();
  process.exit(1);
}

console.log(`→ source : ${sourceDir}  (name=${srcManifest.name} v${srcManifest.version})`);
console.log(`→ target : ${target.dir}`);

// ── Sync the pieces that change between builds ──
const items = ["dist", "native", "manifest.json", "package.json", "icon.png", "assets"];
if (has("--full")) items.push("node_modules");
for (const item of items) {
  const s = join(sourceDir, item);
  if (!existsSync(s)) continue;
  const d = join(target.dir, item);
  rmSync(d, { recursive: true, force: true });
  cpSync(s, d, { recursive: true });
  console.log(`  ✓ ${item}`);
}

cleanup?.();
console.log(
  `\n✔ Deployed. Reload in Claude Desktop: Settings ▸ Extensions, toggle "${target.manifest.display_name ?? srcManifest.name}" off then on (or fully Quit + reopen).`,
);
