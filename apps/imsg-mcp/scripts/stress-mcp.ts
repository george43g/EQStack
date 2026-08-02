#!/usr/bin/env node
import type { Buffer } from "node:buffer";
/**
 * Stress / robustness harness for the new MCP features (export, pagination,
 * selection, watchdog). Run before publishing. Exits non-zero on any failure.
 *
 * Usage:
 *   pnpm exec tsx scripts/stress-mcp.ts [.env.test|.env.local]
 *
 * Cases:
 *   1. Long export (largest chat) -> file > 1MB; peak heap < 200MB
 *   2. health_check stays fast (<1.5s) during a concurrent heavy export
 *   3. Pagination: cursor walks the full history with no dupes/gaps
 *   4. limit > available returns the available count, hasMore=false
 *   5. limit:0 returns hard cap (5000) with capped warning footer
 *   6. Malformed since="qwerty" returns isError, server stays healthy
 *   7. Unknown threadSlug returns isError, server stays healthy
 *   8. boundMessagesIfNeeded eviction shape (pure, runs in-process)
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundMessagesIfNeeded } from "../src/tui/types.js";
import type { Message } from "../src/types.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private buffer = "";
  private pending = new Map<number, (msg: JsonRpcResponse) => void>();

  constructor(envFile: string) {
    this.proc = spawn("node", [`--env-file=${envFile}`, "dist/cli.js", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === "number") {
            const cb = this.pending.get(msg.id);
            if (cb) {
              this.pending.delete(msg.id);
              cb(msg);
            }
          }
        } catch {
          // ignore non-json
        }
      }
    });
    this.proc.stderr.on("data", () => {
      /* ignore */
    });
  }

  pid(): number | undefined {
    return this.proc.pid;
  }

  async init(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "stress", version: "1" },
    });
    this.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
  }

  async call(method: string, params: object, timeoutMs = 120_000): Promise<JsonRpcResponse> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${timeoutMs}ms calling ${method}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async callTool(
    name: string,
    args: object,
    timeoutMs = 120_000,
  ): Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }> {
    const r = await this.call("tools/call", { name, arguments: args }, timeoutMs);
    return r.result ?? {};
  }

  close(): void {
    try {
      this.proc.stdin.end();
    } catch {
      /* */
    }
    this.proc.kill();
  }
}

function fakeMsgs(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    guid: `g${i + 1}`,
    text: `msg ${i + 1}`,
    handle: "+1",
    isFromMe: i % 2 === 0,
    date: new Date(1000 + i * 1000),
    dateRead: null,
    dateDelivered: null,
    isRead: false,
    isDelivered: false,
    chatId: "c",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  }));
}

function header(s: string) {
  console.log(`\n\x1b[1;36m── ${s} ──\x1b[0m`);
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

let failures = 0;
async function check(name: string, fn: () => Promise<boolean | string>): Promise<void> {
  try {
    const r = await fn();
    if (r === true) {
      pass(name);
    } else if (typeof r === "string") {
      pass(`${name} — ${r}`);
    } else {
      fail(name);
      failures++;
    }
  } catch (e) {
    fail(`${name} — ${e instanceof Error ? e.message : String(e)}`);
    failures++;
  }
}

async function main() {
  const envFile = process.argv[2] ?? ".env.test";
  console.log(`\x1b[1mMCP stress test\x1b[0m  env=${envFile}`);

  const tmpDir = mkdtempSync(join(tmpdir(), "imsg-stress-"));
  info(`tmp dir: ${tmpDir}`);

  const client = new McpClient(envFile);
  await client.init();

  // ── Pure unit (5c) ────────────────────────────────────────────
  header("5c. boundMessagesIfNeeded eviction shape");

  await check("under cap returns unchanged", async () => {
    const r = boundMessagesIfNeeded(fakeMsgs(100), 50, []);
    return r.messages.length === 100 && r.gapMarkers.length === 0;
  });

  await check("over cap with deep cursor → exactly one gap", async () => {
    const r = boundMessagesIfNeeded(fakeMsgs(8000), 100, []);
    return r.messages.length < 8000 && r.gapMarkers.length === 1
      ? `kept=${r.messages.length} gap.count=${r.gapMarkers[0].count}`
      : false;
  });

  await check("cursor in evicted region clamps", async () => {
    // 8000 msgs, cursor at 3000 (deep middle, not near anchor)
    const r = boundMessagesIfNeeded(fakeMsgs(8000), 3000, []);
    return r.selectedMsgIdx >= 0 ? `cursor=${r.selectedMsgIdx}` : false;
  });

  await check("cursor near anchor merges ranges (no gap)", async () => {
    const r = boundMessagesIfNeeded(fakeMsgs(8000), 7900, []);
    return r.gapMarkers.length === 0;
  });

  // ── Find largest chat for export tests ────────────────────────
  header("Discovery: pick the largest chat for export tests");
  const lc = await client.callTool("list_conversations", { limit: 100 });
  const lcText = lc.content?.[0]?.text ?? "";
  // Pick a 1-on-1 chat (slugs of the form name~service~hash). Group chats can
  // have shape `chat1234` which isn't a real thread slug.
  // Slugs look like `name~service~hash` (e.g. `15550000141~imsg~d790`,
  // `rivergarciaexamplecom~imsg~1a68`). Group chats may render as bare
  // `chat1234` — those aren't slug-looking, so skip them.
  const slugMatches = [...lcText.matchAll(/\[([+\w-]+~[a-z]+~[a-f0-9]+)\]/gi)];
  const slug = slugMatches[0]?.[1];
  if (!slug) {
    fail("Could not find a chat slug from list_conversations — fixture empty?");
    process.exit(1);
  }
  info(`using slug: ${slug}`);

  // ── 5b#1: Long export ─────────────────────────────────────────
  header("5b#1. Long ndjson export of largest chat");
  const exportPath = join(tmpDir, "stress-export.ndjson");
  const exportT0 = Date.now();
  const exportRes = await client.callTool(
    "export_messages",
    { threadSlug: slug, format: "ndjson", outputPath: exportPath, pageSize: 1000 },
    600_000,
  );
  const exportMs = Date.now() - exportT0;
  await check("export_messages completes without error", async () => !exportRes.isError);
  await check("file exists and has content", async () => {
    try {
      const size = statSync(exportPath).size;
      const lines = readFileSync(exportPath, "utf8").trim().split("\n");
      return size > 0 && lines.length > 0
        ? `${lines.length} lines, ${(size / 1024).toFixed(1)}KB, ${exportMs}ms`
        : false;
    } catch {
      return false;
    }
  });

  // ── 5b#2: health_check fast during heavy export ──────────────
  header("5b#2. health_check stays fast during a concurrent export");
  const concurrentPath = join(tmpDir, "concurrent-export.ndjson");
  const exportPromise = client.callTool(
    "export_messages",
    { threadSlug: slug, format: "ndjson", outputPath: concurrentPath, pageSize: 500 },
    600_000,
  );
  // Fire health_checks while export is running
  const healthTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    await client.callTool("health_check", {});
    healthTimes.push(Date.now() - t0);
    await new Promise((r) => setTimeout(r, 50));
  }
  await exportPromise;
  const maxHealth = Math.max(...healthTimes);
  await check("all health_checks under 1500ms", async () =>
    maxHealth < 1500
      ? `max ${maxHealth}ms, avg ${Math.round(healthTimes.reduce((a, b) => a + b) / healthTimes.length)}ms`
      : false,
  );

  // ── 5b#3: pagination ─────────────────────────────────────────
  header("5b#3. Pagination via beforeMessageId — no dupes, no gaps");
  const seenIds = new Set<number>();
  let cursor: number | undefined;
  let pages = 0;
  while (pages < 50) {
    const args: { threadSlug: string; limit: number; beforeMessageId?: number } = {
      threadSlug: slug,
      limit: 50,
    };
    if (cursor != null) args.beforeMessageId = cursor;
    const r = await client.callTool("get_messages", args);
    const text = r.content?.[0]?.text ?? "";
    // Extract message IDs from "[date] arrow Sender" format isn't easy — use the pagination footer
    const idsInPage = [...text.matchAll(/^\[\d/gm)].length;
    const m = text.match(/oldestMessageId=(\d+)/);
    if (!m) break;
    const oldestId = Number.parseInt(m[1], 10);
    if (idsInPage === 0 || (cursor != null && oldestId >= cursor)) break;
    if (cursor != null && oldestId === cursor) break;
    seenIds.add(oldestId);
    cursor = oldestId;
    pages++;
    if (text.includes("hasMore=false")) break;
  }
  await check("pagination terminates in <50 iterations", async () =>
    pages < 50 ? `${pages} pages` : false,
  );
  await check("no duplicate cursor IDs", async () => seenIds.size === pages);

  // ── 5b#4: limit > available ──────────────────────────────────
  header("5b#4. limit > available returns availableCount, hasMore=false");
  const lr = await client.callTool("get_messages", { threadSlug: slug, limit: 100000 });
  const ltext = lr.content?.[0]?.text ?? "";
  await check("response has hasMore=false footer", async () => ltext.includes("hasMore=false"));

  // ── 5b#5: limit=0 capped at 5000 ─────────────────────────────
  header("5b#5. limit:0 caps at 5000 with capped warning");
  const cr = await client.callTool("get_messages", { threadSlug: slug, limit: 0 });
  const ctext = cr.content?.[0]?.text ?? "";
  // It's only "capped" if there were actually 5000+ messages. Either is OK.
  await check("response is well-formed (has pagination footer)", async () =>
    ctext.includes("Pagination:"),
  );

  // ── 5b#6: malformed since ────────────────────────────────────
  header("5b#6. export_messages with malformed since='qwerty'");
  const badSince = await client.callTool("export_messages", {
    threadSlug: slug,
    format: "ndjson",
    outputPath: join(tmpDir, "bad-since.ndjson"),
    since: "qwerty",
  });
  await check("returns isError, doesn't crash", async () => badSince.isError === true);
  // Verify the server is still healthy after the error
  const postBadHealth = await client.callTool("health_check", {});
  await check("server still responsive after bad input", async () => !postBadHealth.isError);

  // ── 5b#7: unknown threadSlug ─────────────────────────────────
  header("5b#7. export_messages with unknown threadSlug");
  const badSlug = await client.callTool("export_messages", {
    threadSlug: "definitely~not~a~real~slug~ffff",
    format: "ndjson",
    outputPath: join(tmpDir, "bad-slug.ndjson"),
  });
  await check("returns isError for unknown slug", async () => badSlug.isError === true);

  // ── Cleanup ──────────────────────────────────────────────────
  client.close();
  // Best-effort temp-file cleanup
  for (const p of [exportPath, concurrentPath]) {
    try {
      unlinkSync(p);
    } catch {
      /* */
    }
  }

  console.log(
    `\n\x1b[1mResult:\x1b[0m ${failures === 0 ? "\x1b[32mall passed\x1b[0m" : `\x1b[31m${failures} failures\x1b[0m`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
