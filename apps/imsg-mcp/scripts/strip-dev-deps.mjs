#!/usr/bin/env node
/**
 * Remove devDependencies from a staged package.json.
 *
 * The .mcpb staging step copies the app's package.json into
 * release/mcpb-stage/ and runs `npm install --omit=dev` there to vendor the
 * production deps into the bundle. npm parses EVERY dependency spec before
 * honoring --omit, and the monorepo's `workspace:*` devDeps (@eqstack/*) are
 * a protocol npm has never supported -> EUNSUPPORTEDPROTOCOL, which killed
 * the release prepare step (run 31307553908). The staged copy is disposable
 * and the bundle never needs devDeps, so drop the whole block before npm
 * touches it.
 *
 * Usage: node scripts/strip-dev-deps.mjs <staged-dir>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: strip-dev-deps.mjs <staged-dir>");
  process.exit(1);
}
const path = join(dir, "package.json");
const pkg = JSON.parse(readFileSync(path, "utf8"));
delete pkg.devDependencies;
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`stripped devDependencies from ${path}`);
