// Benchmark driver: tmux-mcp-rs vs tmux-mcp (Node).
//
// Run with: `pnpm tsx scripts/bench-tmux-mcp.ts`
// Output:   docs/tmux-mcp-bench.md
//
// Approach: spawn each MCP server as a child process, drive it with the
// official `@modelcontextprotocol/sdk` stdio client, measure each metric
// against a hot session. Both servers expose `list-sessions`,
// `create-session`, `execute-command`, `get-command-result`,
// `capture-pane`, `kill-session` — the common subset we benchmark.
//
// The Rust server is pinned to its own per-bench tmux socket
// (/tmp/tmux-rust-bench.sock). The Node server's CLI parser only
// accepts `--shell-type` (no `--socket`), so it talks to tmux's default
// socket — fine for the benchmark because each round-trip targets a
// uniquely-named session we own.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The rust server publishes JSON schemas with `format: uint32` / `uint64`,
// which Ajv doesn't recognise. The SDK forwards Ajv's per-schema
// warnings to stderr (dozens per `tools/list`). They are cosmetic — the
// validation falls back to plain integer checks — so silence them so
// the bench output is readable.
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  const s = typeof chunk === "string" ? chunk : chunk.toString();
  if (s.startsWith("unknown format ")) return true;
  return _origStderrWrite(chunk, ...(rest as Parameters<typeof _origStderrWrite>));
}) as typeof process.stderr.write;

interface ServerSpec {
  name: string;
  language: "rust" | "node";
  cmd: string;
  args: string[];
  /** tmux socket path the server talks to. `null` = default socket. */
  socketPath: string | null;
  /** When true, pre-spawn a tmux server on `socketPath` via shell with
   *  `-f /dev/null` so the user's tmux.conf `run-shell` hooks don't
   *  taint either the daemon's stdio FDs or the per-call timings. When
   *  false, the MCP itself handles `create-session` (used by the Node
   *  server, which only talks to the default socket). */
  shellPreCreate: boolean;
  /** Tools we call by name in the benchmark — used for shape checks. */
  ops: {
    listSessions: string;
    createSession: string;
    executeCommand: string;
    capturePane: string;
    killSession: string;
  };
}

const SERVERS: ServerSpec[] = [
  {
    name: "tmux-mcp-rs",
    language: "rust",
    cmd: "/opt/homebrew/bin/tmux-mcp-rs",
    args: ["--shell-type", "zsh", "--socket", "/tmp/tmux-rust-bench.sock"],
    socketPath: "/tmp/tmux-rust-bench.sock",
    shellPreCreate: true,
    ops: {
      listSessions: "list-sessions",
      createSession: "create-session",
      executeCommand: "execute-command",
      capturePane: "capture-pane",
      killSession: "kill-session",
    },
  },
  {
    name: "tmux-mcp",
    language: "node",
    cmd: "npx",
    args: ["-y", "--", "tmux-mcp", "--shell-type=zsh"],
    socketPath: null,
    shellPreCreate: false,
    ops: {
      listSessions: "list-sessions",
      createSession: "create-session",
      executeCommand: "execute-command",
      capturePane: "capture-pane",
      killSession: "kill-session",
    },
  },
];

const IDLE_ITERATIONS = 50;
const WRITE_ITERATIONS = 30;
const PARALLEL_FANOUT = 10;
const MEMORY_SAMPLE_TICKS = 6;
const MEMORY_TICK_MS = 1000;

interface MetricResult {
  metric: string;
  value: string;
  unit: string;
}

interface BenchResult {
  server: string;
  language: string;
  metrics: MetricResult[];
  errors: string[];
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

function fmtP(samples: number[]): string {
  if (samples.length === 0) return "n/a";
  const s = [...samples].sort((a, b) => a - b);
  const p50 = quantile(s, 0.5).toFixed(1);
  const p95 = quantile(s, 0.95).toFixed(1);
  const p99 = quantile(s, 0.99).toFixed(1);
  return `${p50} / ${p95} / ${p99}`;
}

async function pollPidRss(pid: number): Promise<number | null> {
  return await new Promise((resolve) => {
    const ps = nodeSpawn("ps", ["-o", "rss=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    ps.stdout.on("data", (b) => {
      out += b.toString();
    });
    ps.on("close", () => {
      const kb = Number.parseInt(out.trim(), 10);
      resolve(Number.isFinite(kb) ? kb / 1024 : null);
    });
    ps.on("error", () => resolve(null));
  });
}

async function runTmux(socketPath: string | null, args: string[]): Promise<number> {
  // `-f /dev/null` skips the user's ~/.tmux.conf so background
  // `run-shell` hooks don't (a) keep stdio FDs open forever — which
  // hangs the spawning shell — and (b) pollute the bench timings with
  // unrelated work. Required on dev boxes; harmless on minimal hosts.
  const fullArgs = ["-f", "/dev/null"];
  if (socketPath) fullArgs.push("-S", socketPath);
  fullArgs.push(...args);
  return await new Promise((resolve) => {
    const p = nodeSpawn("tmux", fullArgs, { stdio: "ignore" });
    p.on("close", (code) => resolve(code ?? 0));
    p.on("error", () => resolve(-1));
  });
}

async function killOnlyBenchSession(socketPath: string | null, sessionName: string): Promise<void> {
  await runTmux(socketPath, ["kill-session", "-t", sessionName]);
}

interface ConnectedServer {
  client: Client;
  transport: StdioClientTransport;
}

async function connect(spec: ServerSpec): Promise<ConnectedServer> {
  const transport = new StdioClientTransport({
    command: spec.cmd,
    args: spec.args,
    stderr: "ignore",
  });
  const client = new Client({ name: "tmux-bench", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function disconnect(s: ConnectedServer): Promise<void> {
  try {
    await s.client.close();
  } catch {}
}

// ───────────────────────────────────────────────────────────────────
// Metric routines
// ───────────────────────────────────────────────────────────────────

async function measureColdStart(spec: ServerSpec): Promise<MetricResult> {
  const samples: number[] = [];
  // Single cold start measurement per server; npx in particular has its
  // own dependency-resolution warmup on the first call, so we discard
  // the very first run as warmup and report the second.
  for (let i = 0; i < 2; i++) {
    const t0 = performance.now();
    const s = await connect(spec);
    await s.client.listTools();
    const elapsed = performance.now() - t0;
    await disconnect(s);
    samples.push(elapsed);
  }
  return {
    metric: "Cold start (spawn → tools/list)",
    value: samples[1].toFixed(0),
    unit: "ms",
  };
}

const PER_CALL_TIMEOUT_MS = 5_000;

async function measureRoundTripIdle(spec: ServerSpec, s: ConnectedServer): Promise<MetricResult> {
  const samples: number[] = [];
  for (let i = 0; i < IDLE_ITERATIONS; i++) {
    const t0 = performance.now();
    await s.client.callTool({ name: spec.ops.listSessions, arguments: {} }, undefined, {
      timeout: PER_CALL_TIMEOUT_MS,
    });
    samples.push(performance.now() - t0);
  }
  return {
    metric: "Round-trip latency, idle (p50 / p95 / p99)",
    value: fmtP(samples),
    unit: "ms",
  };
}

async function measureRoundTripWrite(
  spec: ServerSpec,
  s: ConnectedServer,
  sessionName: string,
): Promise<MetricResult> {
  const samples: number[] = [];
  for (let i = 0; i < WRITE_ITERATIONS; i++) {
    const t0 = performance.now();
    await s.client.callTool(
      {
        name: spec.ops.executeCommand,
        arguments: { command: "true", paneId: `${sessionName}:0.0` },
      },
      undefined,
      { timeout: PER_CALL_TIMEOUT_MS },
    );
    samples.push(performance.now() - t0);
  }
  return {
    metric: "Round-trip latency, write (p50 / p95 / p99)",
    value: fmtP(samples),
    unit: "ms",
  };
}

async function measureThroughput(
  spec: ServerSpec,
  s: ConnectedServer,
  sessionName: string,
): Promise<MetricResult> {
  const t0 = performance.now();
  const calls = Array.from({ length: PARALLEL_FANOUT }, () =>
    s.client.callTool(
      {
        name: spec.ops.executeCommand,
        arguments: { command: "true", paneId: `${sessionName}:0.0` },
      },
      undefined,
      { timeout: PER_CALL_TIMEOUT_MS },
    ),
  );
  const results = await Promise.allSettled(calls);
  const wallclock = performance.now() - t0;
  const errors = results.filter((r) => r.status === "rejected").length;
  return {
    metric: "Throughput (10 parallel sends — wallclock / errors)",
    value: `${wallclock.toFixed(0)} ms / ${errors}`,
    unit: "ms,err",
  };
}

async function measureMemory(_spec: ServerSpec, s: ConnectedServer): Promise<MetricResult> {
  const pid = s.transport.pid;
  if (pid == null) {
    return {
      metric: "Memory footprint (RSS avg / max)",
      value: "no pid",
      unit: "MB",
    };
  }
  const samples: number[] = [];
  for (let i = 0; i < MEMORY_SAMPLE_TICKS; i++) {
    const rss = await pollPidRss(pid);
    if (rss != null) samples.push(rss);
    await new Promise((r) => setTimeout(r, MEMORY_TICK_MS));
  }
  if (samples.length === 0) {
    return {
      metric: "Memory footprint (RSS avg / max)",
      value: "n/a",
      unit: "MB",
    };
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const max = Math.max(...samples);
  return {
    metric: "Memory footprint (RSS avg / max)",
    value: `${avg.toFixed(1)} / ${max.toFixed(1)}`,
    unit: "MB",
  };
}

async function measureToolSurface(_spec: ServerSpec, s: ConnectedServer): Promise<MetricResult> {
  const result = await s.client.listTools();
  return {
    metric: "Tool surface (count)",
    value: String(result.tools.length),
    unit: "tools",
  };
}

// ───────────────────────────────────────────────────────────────────
// Harness
// ───────────────────────────────────────────────────────────────────

async function benchOne(spec: ServerSpec): Promise<BenchResult> {
  const errors: string[] = [];
  const metrics: MetricResult[] = [];
  const sessionName = `bench-${spec.language}-${process.pid}`;

  process.stdout.write(`  · cold start\n`);
  try {
    metrics.push(await measureColdStart(spec));
  } catch (e) {
    errors.push(`cold-start: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Spawn one hot server for the rest of the measurements.
  let s: ConnectedServer | null = null;
  try {
    s = await connect(spec);

    process.stdout.write(`  · tool surface\n`);
    metrics.push(await measureToolSurface(spec, s));

    process.stdout.write(`  · setup tmux session ${sessionName}\n`);
    if (spec.shellPreCreate) {
      // The rust MCP doesn't auto-start tmux on a fresh isolated
      // socket; shell-create the session up front (with `-f /dev/null`
      // so the user's tmux.conf doesn't taint timings).
      const setup = await runTmux(spec.socketPath, ["new-session", "-d", "-s", sessionName]);
      if (setup !== 0) {
        throw new Error(`tmux new-session failed (exit ${setup})`);
      }
    } else {
      // The Node MCP only talks to the default tmux socket and can't
      // be told otherwise. Let it create the session via the MCP —
      // proven to work in the dispatch path.
      await s.client.callTool(
        { name: spec.ops.createSession, arguments: { name: sessionName } },
        undefined,
        { timeout: 10_000 },
      );
    }

    process.stdout.write(`  · round-trip idle (${IDLE_ITERATIONS}×)\n`);
    metrics.push(await measureRoundTripIdle(spec, s));

    process.stdout.write(`  · round-trip write (${WRITE_ITERATIONS}×)\n`);
    try {
      metrics.push(await measureRoundTripWrite(spec, s, sessionName));
    } catch (e) {
      errors.push(`write-rt: ${e instanceof Error ? e.message : String(e)}`);
      metrics.push({
        metric: "Round-trip latency, write (p50 / p95 / p99)",
        value: "error",
        unit: "ms",
      });
    }

    process.stdout.write(`  · throughput (${PARALLEL_FANOUT}×)\n`);
    try {
      metrics.push(await measureThroughput(spec, s, sessionName));
    } catch (e) {
      errors.push(`throughput: ${e instanceof Error ? e.message : String(e)}`);
      metrics.push({
        metric: "Throughput (10 parallel sends — wallclock / errors)",
        value: "error",
        unit: "ms,err",
      });
    }

    process.stdout.write(`  · memory (${MEMORY_SAMPLE_TICKS}× ${MEMORY_TICK_MS}ms)\n`);
    metrics.push(await measureMemory(spec, s));
  } catch (e) {
    errors.push(`hot: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (s) await disconnect(s);
    await killOnlyBenchSession(spec.socketPath, sessionName);
    if (spec.socketPath) {
      // The rust server's per-bench socket is exclusive to this run.
      await runTmux(spec.socketPath, ["kill-server"]);
      await fs.rm(spec.socketPath, { force: true }).catch(() => {});
    }
  }

  return { server: spec.name, language: spec.language, metrics, errors };
}

// ───────────────────────────────────────────────────────────────────
// Renderer
// ───────────────────────────────────────────────────────────────────

function renderMarkdown(results: BenchResult[]): string {
  const orderedMetricNames = Array.from(
    new Set(results.flatMap((r) => r.metrics.map((m) => m.metric))),
  );
  const headers = ["Metric", "Unit", ...results.map((r) => `${r.server} (${r.language})`)];
  const lines: string[] = [];
  lines.push("# tmux MCP — benchmark");
  lines.push("");
  lines.push(
    "Generated by [`scripts/bench-tmux-mcp.ts`](../scripts/bench-tmux-mcp.ts). " +
      "See [`docs/tmux-mcp-setup.md`](./tmux-mcp-setup.md) for the wiring " +
      "recipe both servers depend on.",
  );
  lines.push("");
  lines.push(`Run timestamp: ${new Date().toISOString()}`);
  lines.push(`Host: ${process.platform} ${process.arch}, Node ${process.version}`);
  lines.push("");
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const name of orderedMetricNames) {
    const cells: string[] = [name];
    const unit = results.flatMap((r) => r.metrics).find((m) => m.metric === name)?.unit ?? "";
    cells.push(unit);
    for (const r of results) {
      const m = r.metrics.find((mm) => mm.metric === name);
      cells.push(m ? m.value : "—");
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    `- **Cold start**: time from \`StdioClientTransport.start()\` to first \`tools/list\` response. The very first run is discarded as warmup (npx in particular pays a one-shot dependency-resolution cost); the reported value is the second run.`,
  );
  lines.push(
    `- **Round-trip idle**: ${IDLE_ITERATIONS} sequential \`list-sessions\` calls against a hot connection.`,
  );
  lines.push(
    `- **Round-trip write**: ${WRITE_ITERATIONS} sequential \`execute-command\` calls running \`true\` inside a dedicated \`bench-*\` session.`,
  );
  lines.push(
    `- **Throughput**: ${PARALLEL_FANOUT} parallel \`execute-command\` calls via \`Promise.allSettled\`; reports total wallclock + rejected count.`,
  );
  lines.push(
    `- **Memory**: ${MEMORY_SAMPLE_TICKS} samples of \`ps -o rss=\` against the server's own pid, ${MEMORY_TICK_MS}ms apart.`,
  );
  lines.push(
    `- **Tool surface**: \`tools/list\` length. Both servers expose overlapping verbs; the Node implementation has a smaller surface (no \`send-keys\` variants, no \`buffer-*\`, no \`layout/zoom\` controls).`,
  );
  lines.push("");
  for (const r of results) {
    if (r.errors.length > 0) {
      lines.push(`### ${r.server} — errors`);
      for (const e of r.errors) lines.push(`- ${e}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

// ───────────────────────────────────────────────────────────────────
// Entry
// ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results: BenchResult[] = [];
  for (const spec of SERVERS) {
    process.stdout.write(`▶ ${spec.name} (${spec.language})\n`);
    results.push(await benchOne(spec));
  }
  const md = renderMarkdown(results);
  const out = path.resolve(process.cwd(), "docs/tmux-mcp-bench.md");
  await fs.writeFile(out, md, "utf8");
  process.stdout.write(`✓ wrote ${out}\n`);
}

main().catch((err) => {
  process.stderr.write(`bench failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
