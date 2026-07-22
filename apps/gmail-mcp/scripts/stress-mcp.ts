#!/usr/bin/env node
/**
 * Stress harness for the Gmail MCP server.
 *
 * Spawns the MCP as a child process and runs a set of robustness checks
 * over JSON-RPC. Designed to run without real Gmail auth — the cases that
 * would normally hit Gmail are crafted to exercise schema validation,
 * timeouts, signal handling, and the health_check canary instead.
 *
 * Run: `npm run stress`
 *
 * Exit code 0 if all cases pass, 1 otherwise.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENTRY = resolve(ROOT, "src/cli/index.ts");
const FIXTURE_ENV = {
  GMAIL_FIXTURE_MODE: "1",
  GMAIL_FIXTURE_DIR: resolve(ROOT, "fixtures/gmail"),
  GMAIL_CONFIG_DIR: "",
  GMAIL_ACCOUNT: "work",
};

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: { content?: { type: string; text: string }[]; isError?: boolean; tools?: unknown[] };
  error?: { code: number; message: string };
}

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (msg: RpcResponse) => void>();
  public stderr = "";

  constructor(env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, ["--import", "tsx", ENTRY, "mcp"], {
      cwd: ROOT,
      env: { ...process.env, ...FIXTURE_ENV, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: RpcResponse;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed.id === "number") {
        const cb = this.pending.get(parsed.id);
        if (cb) {
          this.pending.delete(parsed.id);
          cb(parsed);
        }
      }
    }
  }

  private send(req: RpcRequest): void {
    this.child.stdin.write(`${JSON.stringify(req)}\n`);
  }

  notification(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params?: unknown, timeoutMs = 8_000): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise((resolveResp, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveResp(msg);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "stress", version: "0.0.1" },
    });
    this.notification("notifications/initialized");
  }

  pid(): number | undefined {
    return this.child.pid;
  }

  async waitExit(timeoutMs = 5_000): Promise<{ code: number | null; signal: string | null }> {
    return await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolveExit({ code: null, signal: "TIMEOUT" });
      }, timeoutMs);
      this.child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child.kill(signal);
  }
}

interface CaseResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: CaseResult[] = [];

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`[${tag}] ${name}${suffix}`);
}

async function caseHandshake(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    const tools = await c.request("tools/list", {});
    const count = (tools.result?.tools as unknown[] | undefined)?.length ?? 0;
    record("handshake + tools/list", count >= 26, `${count} tools`);
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseHealthCheckCanary(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    const r = await c.request("tools/call", {
      name: "health_check",
      arguments: {},
    });
    const text = r.result?.content?.[0]?.text ?? "";
    const ok = text.includes("Status: healthy") && text.includes("PID:");
    record("health_check returns Status: healthy", ok, ok ? undefined : text.slice(0, 80));
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseHealthUnderLoad(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    // 20 parallel health_check calls
    const calls = Array.from({ length: 20 }, () =>
      c.request("tools/call", { name: "health_check", arguments: {} }, 5_000),
    );
    const responses = await Promise.all(calls);
    const allHealthy = responses.every((r) =>
      (r.result?.content?.[0]?.text ?? "").includes("Status: healthy"),
    );
    record("20 parallel health_checks all healthy", allHealthy);
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseUnknownTool(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    const r = await c.request("tools/call", {
      name: "definitely_not_a_real_tool",
      arguments: {},
    });
    const text = r.result?.content?.[0]?.text ?? "";
    // The dispatcher's scope check rejects unknown tools first
    const rejected = text.includes("not available") || text.includes("Unknown tool");
    record("unknown tool name is rejected", rejected, text.slice(0, 80));
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseMalformedSchema(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    // search_emails requires a string `query`; pass a number instead.
    const r = await c.request("tools/call", {
      name: "search_emails",
      arguments: { query: 12345 },
    });
    const text = r.result?.content?.[0]?.text ?? "";
    const ok = text.toLowerCase().includes("query") || text.toLowerCase().includes("expected");
    record("malformed schema input returns error", ok, text.slice(0, 80));
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseForcedTimeout(): Promise<void> {
  const c = new McpClient({
    MCP_TOOL_TIMEOUT_FORCE_MS: "1",
    GMAIL_FIXTURE_DELAY_MS: "25",
  });
  try {
    await c.initialize();
    const r = await c.request("tools/call", {
      name: "list_email_labels",
      arguments: {},
    });
    const text = r.result?.content?.[0]?.text ?? "";
    const ok = r.result?.isError === true && text.includes("timed out after 1ms");
    record("MCP_TOOL_TIMEOUT_FORCE_MS=1 produces timeout error", ok, text.slice(0, 80));
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseMcpSelfHealsAfterTimeout(): Promise<void> {
  // Force a 1ms tool timeout. First call must return isError:true with a clean
  // "timed out" envelope. The server must REMAIN ALIVE and serve a second call
  // (we issue an "unknown tool" which intentionally fails fast — proves the
  // dispatcher is responsive after a timeout). Self-healing contract: one
  // misbehaving tool doesn't kill the MCP.
  const c = new McpClient({
    MCP_TOOL_TIMEOUT_FORCE_MS: "1",
    GMAIL_FIXTURE_DELAY_MS: "25",
  });
  try {
    await c.initialize();

    const r1 = await c.request("tools/call", {
      name: "list_email_labels",
      arguments: {},
    });
    const r1Text = r1.result?.content?.[0]?.text ?? "";
    const firstTimedOut = r1.result?.isError === true && r1Text.includes("timed out");

    // Server is still alive — issue a second request. We use `tools/list` so
    // we don't need credentials; just want to prove the dispatcher responds.
    const r2 = await c.request("tools/list", {});
    const secondResponded = Array.isArray(r2.result?.tools) && r2.result.tools.length >= 26;

    const ok = firstTimedOut && secondResponded;
    record(
      "MCP self-heals: serves the next call after a timed-out one",
      ok,
      `firstTimedOut=${firstTimedOut} secondResponded=${secondResponded}`,
    );
  } finally {
    c.kill();
    await c.waitExit();
  }
}

async function caseSigTermClean(): Promise<void> {
  const c = new McpClient();
  try {
    await c.initialize();
    c.kill("SIGTERM");
    const exit = await c.waitExit(3_000);
    const ok = exit.code === 0 && exit.signal === null;
    record(
      "SIGTERM produces clean exit code 0 (handler intercepted)",
      ok,
      `code=${exit.code} signal=${exit.signal}`,
    );
  } finally {
    // already exited
  }
}

async function caseRssWatchdogKill(): Promise<void> {
  // Point the watchdog at a dedicated log dir we can inspect afterwards.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "stress-rss-kill-"));
  const c = new McpClient({
    MCP_MAX_RSS_MB: "50",
    MCP_MEMORY_SAMPLE_MS: "500",
    MCP_LOG_DIR: logDir,
  });
  try {
    await c.initialize();
    const exit = await c.waitExit(5_000);
    const killed = exit.signal !== "TIMEOUT";

    // Self-healing audit: the kill must be recorded in NDJSON so post-mortem
    // grep ("which account / tool / time triggered the kill?") works. Without
    // this assertion the operator can't reason about what just died.
    let killLogged = false;
    try {
      const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".ndjson"));
      for (const f of files) {
        const txt = fs.readFileSync(path.join(logDir, f), "utf8");
        if (txt.includes("watchdog_kill") && txt.includes("rss_exceeded")) {
          killLogged = true;
          break;
        }
      }
    } catch {
      /* fall through; killLogged stays false */
    }

    const ok = killed && killLogged;
    record(
      "MCP_MAX_RSS_MB=50 triggers watchdog kill + records reason in NDJSON",
      ok,
      `code=${exit.code} signal=${exit.signal} killLogged=${killLogged}`,
    );
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

async function caseHttpTransport(): Promise<void> {
  // Spin up the MCP in HTTP mode on a random port and exercise the three key
  // surfaces: GET /health (no auth), POST /mcp without token (401), and
  // initialize → tools/list with a valid bearer token + session id.
  const port = 18000 + Math.floor(Math.random() * 1000);
  const token = `stress-token-${Date.now()}`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      ENTRY,
      "mcp",
      "--http",
      `--port=${port}`,
      "--bind=127.0.0.1",
      "--token-env=GMAIL_HTTP_TOKEN",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ...FIXTURE_ENV,
        GMAIL_HTTP_TOKEN: token,
        GMAIL_AUTH_NON_INTERACTIVE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // Wait for the server to start listening (look for the log line).
  const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting (stderr: ${stderr})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  try {
    await waitFor(() => stderr.includes("listening on"), 15_000);

    // GET /health — no auth.
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    const healthOk = healthRes.status === 200 && (await healthRes.text()).startsWith("Status: ");

    // POST /mcp without token → 401.
    const noAuthRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const noAuthOk = noAuthRes.status === 401;

    // POST /mcp with token, full handshake → tools/list.
    const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "stress", version: "0" },
        },
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id");
    const initOk = initRes.status === 200 && !!sessionId;

    let toolsCount = 0;
    if (initOk && sessionId) {
      // notifications/initialized
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      // tools/list
      const toolsRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      const toolsBody = await toolsRes.text();
      // Streamable HTTP returns SSE-formatted; count tool names in the data line.
      toolsCount = (toolsBody.match(/"name":/g) ?? []).length;
    }

    const ok = healthOk && noAuthOk && initOk && toolsCount > 20;
    record(
      "HTTP transport: /health + bearer auth + tools/list",
      ok,
      `health=${healthOk} 401=${noAuthOk} init=${initOk} tools=${toolsCount}`,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 3000);
      child.on("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

async function main(): Promise<void> {
  console.log("Stress harness starting...");
  const cases = [
    caseHandshake,
    caseHealthCheckCanary,
    caseHealthUnderLoad,
    caseUnknownTool,
    caseMalformedSchema,
    caseForcedTimeout,
    caseMcpSelfHealsAfterTimeout,
    caseSigTermClean,
    caseRssWatchdogKill,
    caseHttpTransport,
  ];
  for (const c of cases) {
    try {
      await c();
    } catch (e) {
      record(c.name, false, (e as Error).message);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n${passed}/${total} cases passed`);
  process.exit(passed === total ? 0 : 1);
}

main();
