#!/usr/bin/env tsx
/**
 * Copy local macOS databases into env-data/ so cloud agents can work
 * without a real macOS environment. Run: pnpm sync-env-data
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const dest = join(root, "env-data");

interface CopyTask {
  label: string;
  src: string;
  dst: string;
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function buildTasks(): CopyTask[] {
  const tasks: CopyTask[] = [];

  const chatDb = join(homedir(), "Library", "Messages", "chat.db");
  tasks.push({ label: "chat.db", src: chatDb, dst: join(dest, "chat.db") });

  const abDir = join(homedir(), "Library", "Application Support", "AddressBook");
  const mainDb = join(abDir, "AddressBook-v22.abcddb");
  tasks.push({
    label: "AddressBook (main)",
    src: mainDb,
    dst: join(dest, "AddressBook", "AddressBook-v22.abcddb"),
  });

  const sourcesDir = join(abDir, "Sources");
  if (existsSync(sourcesDir)) {
    try {
      for (const d of readdirSync(sourcesDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const sourceDb = join(sourcesDir, d.name, "AddressBook-v22.abcddb");
        if (existsSync(sourceDb)) {
          tasks.push({
            label: `AddressBook source ${d.name}`,
            src: sourceDb,
            dst: join(dest, "AddressBook", "Sources", d.name, "AddressBook-v22.abcddb"),
          });
        }
      }
    } catch (err) {
      console.warn(`  WARN  could not read AddressBook Sources (${sourcesDir}):`, err);
    }
  }

  const slugsDb = join(homedir(), ".imsg-mcp", "slugs.db");
  tasks.push({ label: "slugs.db", src: slugsDb, dst: join(dest, "slugs.db") });

  return tasks;
}

function main() {
  const tasks = buildTasks();
  let copied = 0;
  let skipped = 0;

  for (const t of tasks) {
    if (!existsSync(t.src)) {
      console.log(`  SKIP  ${t.label} (${t.src} not found)`);
      skipped++;
      continue;
    }
    ensureDir(t.dst);
    copyFileSync(t.src, t.dst);
    console.log(`  COPY  ${t.label} -> ${t.dst}`);
    copied++;
  }

  console.log(`\nDone: ${copied} copied, ${skipped} skipped.`);
}

main();
