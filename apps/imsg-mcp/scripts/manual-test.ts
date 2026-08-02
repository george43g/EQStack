#!/usr/bin/env node

/**
 * Manual test harness — exercises the IMessageDB layer directly against
 * the env-data/ fixture (not live data). Used for bug hunting and stress
 * testing without going through MCP/Cursor restart races.
 *
 * Usage:
 *   pnpm exec tsx scripts/manual-test.ts [test-name]
 *
 * Tests (run all if no argument):
 *   limits         — verify limit param works at high values
 *   leaks          — scan all conversations for typedstream artifact leaks
 *   parser-hang    — confirm typedstream parser doesn't hang on edge cases
 *   perf           — benchmark listConversations / getMessagesForChat
 *   stress         — fetch large message sets, look for crashes
 */

import { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } from "../src/config.js";
import { IMessageDB } from "../src/imessage-db.js";

function header(name: string) {
  console.log(`\n\x1b[1;36m── ${name} ──\x1b[0m`);
}

function pass(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function info(msg: string) {
  console.log(`  \x1b[2m· ${msg}\x1b[0m`);
}

interface Suspicious {
  threadSlug: string;
  field: "snippet" | "msgText";
  value: string;
  reason: string;
}

const SUSPICIOUS_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /\$class(name)?/i, reason: "typedstream metadata leak" },
  { regex: /NSValue|NSObject|NSString|NSDictionary/, reason: "NS class name leak" },
  { regex: /streamtyped/i, reason: "typedstream header leak" },
  // Flag suspicious binary markers — but allow text that uses *, ) for legitimate purposes
  // Only flag when followed by other typedstream-looking content (multiple symbols in a row).
  { regex: /^[)*+]{2,}/, reason: "starts with multiple binary marker chars" },
  { regex: /\u{1FFFD}|\\u00[0-1][0-9a-f]/iu, reason: "unrecoverable replacement char" },
];

const ALLOWED_PLACEHOLDERS = new Set(["(image/attachment)", "(no text)", "(attachment)"]);

function findSuspicious(value: string | null | undefined): string | null {
  if (!value) return null;
  if (ALLOWED_PLACEHOLDERS.has(value.trim())) return null;
  for (const { regex, reason } of SUSPICIOUS_PATTERNS) {
    if (regex.test(value)) return reason;
  }
  return null;
}

async function testLimits(db: IMessageDB) {
  header("Test: limits");
  const t0 = performance.now();
  const convs = await db.listConversations(500);
  const t1 = performance.now();
  info(`listConversations(500) → ${convs.length} convs in ${(t1 - t0).toFixed(0)}ms`);
  if (convs.length > 50) pass("limit > 50 returns more than 50 conversations");
  else info(`(only ${convs.length} chats in fixture — can't test >50 limit)`);

  if (convs.length > 0) {
    const slug = convs[0].chatIdentifier;
    const t2 = performance.now();
    const msgs = await db.getMessagesForChat(slug, 1000);
    const t3 = performance.now();
    info(`getMessagesForChat(${slug}, 1000) → ${msgs.length} msgs in ${(t3 - t2).toFixed(0)}ms`);
    if (msgs.length > 100) pass("limit > 100 returns more than 100 messages");
  }
}

async function testLeaks(db: IMessageDB) {
  header("Test: leaks (typedstream artifacts in snippets/messages)");
  const found: Suspicious[] = [];
  const convs = await db.listConversations(500);
  info(`Scanning ${convs.length} conversations for snippet leaks...`);

  for (const c of convs) {
    const reason = findSuspicious(c.lastMessageSnippet);
    if (reason) {
      found.push({
        threadSlug: c.threadSlug,
        field: "snippet",
        value: (c.lastMessageSnippet ?? "").slice(0, 80),
        reason,
      });
    }
  }

  // Check messages from the first 10 most-active conversations
  info(`Scanning messages in first 10 conversations for text artifacts...`);
  for (const c of convs.slice(0, 10)) {
    try {
      const msgs = await db.getMessagesForChat(c.chatIdentifier, 50);
      for (const m of msgs) {
        const reason = findSuspicious(m.text);
        if (reason) {
          found.push({
            threadSlug: c.threadSlug,
            field: "msgText",
            value: (m.text ?? "").slice(0, 80),
            reason,
          });
        }
      }
    } catch (e) {
      fail(
        `getMessagesForChat threw on ${c.threadSlug}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (found.length === 0) {
    pass("no typedstream artifacts found");
  } else {
    fail(`${found.length} suspicious leak(s) detected:`);
    for (const s of found.slice(0, 20)) {
      console.log(`     [${s.threadSlug}] ${s.field}: ${s.reason}`);
      console.log(`     → "${s.value}"`);
    }
    if (found.length > 20) info(`... and ${found.length - 20} more`);
  }
}

async function testParserHang(db: IMessageDB) {
  header("Test: parser hang resistance");
  const convs = await db.listConversations(500);
  info(`Loading messages for all ${convs.length} conversations to look for hangs...`);
  let totalMs = 0;
  let totalMsgs = 0;
  let slowest = { slug: "", ms: 0 };

  for (const c of convs) {
    const t0 = performance.now();
    try {
      // Watchdog: if any single chat takes > 10s, that's a hang
      const msgs = await Promise.race([
        db.getMessagesForChat(c.chatIdentifier, 200),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("HANG: chat took > 10s")), 10_000),
        ),
      ]);
      const ms = performance.now() - t0;
      totalMs += ms;
      totalMsgs += msgs.length;
      if (ms > slowest.ms) slowest = { slug: c.threadSlug, ms };
    } catch (e) {
      fail(`${c.threadSlug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  pass(`Loaded ${totalMsgs} messages across ${convs.length} chats in ${totalMs.toFixed(0)}ms`);
  info(`slowest chat: ${slowest.slug} (${slowest.ms.toFixed(0)}ms)`);
}

async function testPerf(db: IMessageDB) {
  header("Test: perf benchmarks");
  const runs = 5;

  const listTimes: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await db.listConversations(200);
    listTimes.push(performance.now() - t0);
  }
  const avgList = listTimes.reduce((a, b) => a + b) / runs;
  pass(
    `listConversations(200) avg ${avgList.toFixed(0)}ms (${listTimes.map((t) => t.toFixed(0)).join(", ")}ms)`,
  );

  const convs = await db.listConversations(5);
  if (convs.length > 0) {
    const msgTimes: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await db.getMessagesForChat(convs[0].chatIdentifier, 200);
      msgTimes.push(performance.now() - t0);
    }
    const avgMsg = msgTimes.reduce((a, b) => a + b) / runs;
    pass(
      `getMessagesForChat(200) avg ${avgMsg.toFixed(0)}ms (${msgTimes.map((t) => t.toFixed(0)).join(", ")}ms)`,
    );
  }
}

async function testStress(db: IMessageDB) {
  header("Test: stress (large message fetches)");
  const convs = await db.listConversations(500);
  info(`Fetching 1000 messages from each of ${convs.length} chats...`);
  let total = 0;
  const start = performance.now();
  for (const c of convs) {
    try {
      const msgs = await db.getMessagesForChat(c.chatIdentifier, 1000);
      total += msgs.length;
    } catch (e) {
      fail(`${c.threadSlug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const elapsed = performance.now() - start;
  pass(
    `Fetched ${total} total messages in ${elapsed.toFixed(0)}ms (${(total / (elapsed / 1000)).toFixed(0)} msg/s)`,
  );
}

async function main() {
  const test = process.argv[2] ?? "all";
  console.log(`\x1b[1mManual test harness\x1b[0m`);
  console.log(
    `Engine: ${process.env.IMSG_DISABLE_NATIVE === "1" ? "TS (forced)" : "auto (native if available)"}`,
  );
  console.log(`Test mode: ${test}`);

  const db = new IMessageDB(getImsgDbPath(), getContactsDbPaths(), getSlugsDbPath());

  try {
    if (test === "limits" || test === "all") await testLimits(db);
    if (test === "leaks" || test === "all") await testLeaks(db);
    if (test === "parser-hang" || test === "all") await testParserHang(db);
    if (test === "perf" || test === "all") await testPerf(db);
    if (test === "stress" || test === "all") await testStress(db);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
