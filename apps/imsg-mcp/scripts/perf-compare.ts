/**
 * Perf comparison harness: runs the MCP server twice (native + TS-fallback)
 * and reports the difference for the same workload.
 *
 * Usage:
 *   pnpm exec tsx scripts/perf-compare.ts [.env.test|.env.local]
 */

import type { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}
interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

class McpClient {
  private proc: ReturnType<typeof spawn>;
  private requestId = 0;
  private buffer = "";
  private pending = new Map<number, (msg: JsonRpcResponse) => void>();

  constructor(envFile: string, disableNative: boolean) {
    const env = { ...process.env };
    if (disableNative) env.IMSG_DISABLE_NATIVE = "1";
    this.proc = spawn("node", [`--env-file=${envFile}`, "dist/cli.js", "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => {
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
          /* ignore */
        }
      }
    });
    this.proc.stderr!.on("data", () => {
      /* ignore */
    });
  }

  async init(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "perf-compare", version: "1" },
    });
    this.proc.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
  }

  async call(method: string, params: object): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timeout"));
      }, 30_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async callTool(name: string, args: object): Promise<ToolResult> {
    return this.call("tools/call", { name, arguments: args }) as Promise<ToolResult>;
  }

  close(): void {
    this.proc.stdin!.end();
    this.proc.kill();
  }
}

async function timeIt(_label: string, fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  return ms;
}

async function bench(client: McpClient, label: string): Promise<void> {
  // Warm up to settle caches
  await client.callTool("list_conversations", { limit: 50 });

  const runs = 5;
  const listTimes: number[] = [];
  for (let i = 0; i < runs; i++) {
    listTimes.push(
      await timeIt("list", () => client.callTool("list_conversations", { limit: 200 })),
    );
  }
  const listAvg = listTimes.reduce((a, b) => a + b) / runs;

  // Find a chat identifier for getMessages bench
  const convResult = await client.callTool("list_conversations", { limit: 5 });
  const text = convResult.content?.[0]?.text ?? "";
  const match = text.match(/\(([+\d][^)]+)\)/);
  const chatIdentifier = match ? match[1] : null;

  let msgAvg = 0;
  if (chatIdentifier) {
    const msgTimes: number[] = [];
    for (let i = 0; i < runs; i++) {
      msgTimes.push(
        await timeIt("msgs", () => client.callTool("get_messages", { chatIdentifier, limit: 200 })),
      );
    }
    msgAvg = msgTimes.reduce((a, b) => a + b) / runs;
  }

  console.log(`  ${label}:`);
  console.log(
    `    list_conversations(200) avg: ${listAvg.toFixed(1)}ms (${listTimes.map((t) => t.toFixed(0)).join(", ")})`,
  );
  if (chatIdentifier) {
    console.log(`    get_messages(${chatIdentifier}, 200) avg: ${msgAvg.toFixed(1)}ms`);
  }
}

async function main() {
  const envFile = process.argv[2] ?? ".env.test";
  console.log(`\x1b[1mPerf comparison\x1b[0m`);
  console.log(`Env file: ${envFile}\n`);

  for (const useNative of [true, false]) {
    const label = useNative ? "Native (Rust)" : "Fallback (TS)";
    const client = new McpClient(envFile, !useNative);
    await client.init();
    await bench(client, label);
    client.close();
    // Brief pause between runs
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
