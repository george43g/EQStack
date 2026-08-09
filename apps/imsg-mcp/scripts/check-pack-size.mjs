#!/usr/bin/env node
/**
 * Pack-size guard (CI). Runs `npm pack --dry-run --json` for imsg-mcp and
 * fails if the tarball exceeds MAX_TARBALL_BYTES — catches accidental
 * fixture/DB/asset inclusion before it ships to npm.
 *
 * Baseline measured 2026-08-09: 1,836,645 bytes (1.75 MB) gzipped
 * (dist + darwin-arm64 native module + skills + docs). Threshold is ~25%
 * above that, rounded: 2,300,000 bytes. If the package legitimately grows,
 * raise the threshold here in the same PR and say why.
 *
 * Also asserts dist/cli.js is inside the tarball so an unbuilt tree can't
 * sneak through as a "small enough" empty package. --ignore-scripts skips
 * the prepare/build lifecycle (CI builds beforehand) and keeps stdout as
 * pure JSON.
 *
 * Usage: node scripts/check-pack-size.mjs   (run from apps/imsg-mcp)
 */
import { execSync } from "node:child_process";

const MAX_TARBALL_BYTES = 2_300_000;

const mb = (n) => (n / 1024 / 1024).toFixed(2);

const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const [info] = JSON.parse(raw);
if (!info || typeof info.size !== "number") {
  console.error("check-pack-size: could not parse `npm pack --dry-run --json` output");
  process.exit(1);
}

console.log(`check-pack-size: ${info.name}@${info.version}`);
console.log(`  tarball : ${info.size} bytes (${mb(info.size)} MB), ${info.entryCount} entries`);
console.log(`  unpacked: ${info.unpackedSize} bytes (${mb(info.unpackedSize)} MB)`);
console.log(`  limit   : ${MAX_TARBALL_BYTES} bytes (${mb(MAX_TARBALL_BYTES)} MB)`);

if (!info.files?.some((f) => f.path === "dist/cli.js")) {
  console.error("check-pack-size: FAIL — dist/cli.js missing from tarball (build before packing?)");
  process.exit(1);
}
if (info.size > MAX_TARBALL_BYTES) {
  console.error(
    `check-pack-size: FAIL — tarball ${info.size} bytes exceeds limit ${MAX_TARBALL_BYTES} bytes.`,
  );
  console.error(
    "Largest entries:\n" +
      info.files
        .slice()
        .sort((a, b) => b.size - a.size)
        .slice(0, 10)
        .map((f) => `  ${String(f.size).padStart(9)}  ${f.path}`)
        .join("\n"),
  );
  process.exit(1);
}
console.log("check-pack-size: OK");
