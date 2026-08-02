#!/usr/bin/env tsx
/**
 * Headless TUI workload — runs the same data-fetching + state-management
 * code paths the live TUI uses, but without Ink/terminal rendering. Used
 * by the stress-tui harness as a target for memory / CPU / lag monitoring.
 *
 * Why headless: macOS BSD `script` (the only built-in pty wrapper) refuses
 * to start when its stdin is a pipe, which is always the case when the
 * harness is itself spawned by CI shell. Running Ink directly throws
 * "Raw mode not supported" for the same reason. The data path is the
 * interesting part for memory/CPU regression — render loop bugs (the
 * 1003-mouse-mode bug etc.) are caught by direct unit tests.
 *
 * What it does:
 *   1. Boot the watchdog (reports lag/RSS to the harness via the state file)
 *   2. Open IMessageDB against fixtures-stress (1200 chats, 250k messages)
 *   3. Loop the realistic TUI session shape:
 *      - listConversations(0)            // sidebar load
 *      - getMessagesForChat(top, 200)    // open biggest thread
 *      - getMessagesBefore × 30          // paginate older (bounded window
 *                                            kicks in around 5k messages)
 *      - switch to chat #2, repeat
 *      - listConversations again         // second-time-cached
 *
 * Each iteration is timed and total iterations are reported.
 * Runs until duration_s elapses, then exits 0.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { IMessageDB } from "../src/imessage-db.js";
import { installWatchdog, noteActivity, readWatchdogState } from "../src/watchdog.js";

const FIXTURE_DIR = process.env.IMSG_STRESS_FIXTURE_DIR ?? "fixtures-stress";
const DURATION_S = Number(process.env.IMSG_STRESS_TUI_DURATION_S ?? 60);

async function main(): Promise<void> {
  const dbPath = resolve(FIXTURE_DIR, "chat.db");
  if (!existsSync(dbPath)) {
    console.error(`workload: fixture missing: ${dbPath}`);
    process.exit(2);
  }

  installWatchdog();
  console.log(`workload: opening db ${dbPath}`);
  const t0 = Date.now();
  const db = new IMessageDB(dbPath);
  console.log(`workload: db open (${Date.now() - t0}ms)`);

  const startedAt = Date.now();
  const deadline = startedAt + DURATION_S * 1_000;
  let iter = 0;
  let totalMessagesFetched = 0;

  while (Date.now() < deadline) {
    iter += 1;
    noteActivity();

    // 1. Load conversation list (the sidebar). 5000 ≈ "all" — DB has 1200.
    const tListStart = Date.now();
    const conversations = await db.listConversations(5000);
    const listMs = Date.now() - tListStart;

    if (!conversations.length) {
      console.error("workload: no conversations — abort");
      break;
    }

    // 2. Open biggest thread (the first chat — top-heavy chats are first)
    const top = conversations[0];
    const tMsgStart = Date.now();
    const initial = await db.getMessagesForChat(top.chatIdentifier, 200);
    totalMessagesFetched += initial.length;
    const msgMs = Date.now() - tMsgStart;

    // 3. Paginate older — exercises bounded window + cache eviction
    let oldestId: number | undefined =
      initial.length > 0 ? Math.min(...initial.map((m) => m.id)) : undefined;
    let pageCount = 0;
    const tPageStart = Date.now();
    while (oldestId !== undefined && pageCount < 30) {
      const page = await db.getMessagesForChat(top.chatIdentifier, 200, oldestId);
      if (page.length === 0) break;
      totalMessagesFetched += page.length;
      oldestId = Math.min(...page.map((m) => m.id));
      pageCount += 1;
    }
    const pageMs = Date.now() - tPageStart;

    // 4. Switch to chat #2 (forces cache miss + new thread load)
    const tSwitchStart = Date.now();
    if (conversations.length > 1) {
      const second = await db.getMessagesForChat(conversations[1].chatIdentifier, 200);
      totalMessagesFetched += second.length;
    }
    const switchMs = Date.now() - tSwitchStart;

    const wd = readWatchdogState();
    console.log(
      `iter ${String(iter).padStart(3)}  list=${listMs}ms  open=${msgMs}ms  ` +
        `paginate=${pageMs}ms (${pageCount} pages)  switch=${switchMs}ms  ` +
        `lag=${wd.eventLoopP99Ms.toFixed(0)}ms  rss=${wd.rssMb.toFixed(1)}MB  ` +
        `total-msgs=${totalMessagesFetched}`,
    );

    // Yield to the event loop briefly so the watchdog interval can fire.
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(
    `workload: done — ${iter} iterations in ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("workload: error", err);
  process.exit(1);
});
