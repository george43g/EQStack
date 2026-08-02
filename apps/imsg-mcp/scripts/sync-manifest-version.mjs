// Keeps manifest.json (the .mcpb bundle manifest) on the released version.
// semantic-release only bumps package.json, so without this the bundle
// self-reports whatever version manifest.json was created with.
// Invoked by @semantic-release/exec during prepare: sync, then re-pack the
// bundle so the uploaded .mcpb carries the new version.
// Edits just the version line (no JSON round-trip) to preserve formatting.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/sync-manifest-version.mjs <semver>");
  process.exit(1);
}

const manifestPath = new URL("../manifest.json", import.meta.url);
const original = readFileSync(manifestPath, "utf8");
const updated = original.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
if (updated === original && !original.includes(`"version": "${version}"`)) {
  console.error("manifest.json: no version field found to update");
  process.exit(1);
}
writeFileSync(manifestPath, updated);
console.log(`manifest.json version → ${version}`);
