// Benchmark driver: tmux-mcp-rs vs tmux-mcp (Node).
//
// Run with: `pnpm tsx scripts/bench-tmux-mcp.ts`
// Output:   docs/tmux-mcp-bench.md
//
// Prerequisites:
//   1. `docs/tmux-mcp-setup.md` followed — both servers wired into
//      ~/.claude.json with their distinct sockets.
//   2. Local binaries available:
//        /opt/homebrew/bin/tmux-mcp-rs
//        npx -y tmux-mcp
//   3. A real `tmux` is on PATH (the MCP drives it; we don't ship a
//      mock).
//
// This skeleton runs the metric routines outlined in the plan but does
// NOT yet ship a real MCP stdio client. The intended runtime is to
// connect Claude Code-style: spawn the server, send MCP JSON-RPC, parse
// the responses. The next session wires `@modelcontextprotocol/sdk`'s
// stdio client transport in here; the harness shape, metric definitions,
// and result formatting are stable from this commit on.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

interface ServerSpec {
  /** Display name in the results table. */
  name: string;
  /** Implementation language (informational). */
  language: "rust" | "node";
  /** Argv to spawn the server. */
  cmd: string;
  args: string[];
  /** Per-server tmux socket so the two don't share state. */
  socketPath: string;
}

const SERVERS: ServerSpec[] = [
  {
    name: "tmux-mcp-rs",
    language: "rust",
    cmd: "/opt/homebrew/bin/tmux-mcp-rs",
    args: ["--shell-type", "zsh", "--socket", "/tmp/tmux-rust-bench.sock"],
    socketPath: "/tmp/tmux-rust-bench.sock",
  },
  {
    name: "tmux-mcp",
    language: "node",
    cmd: "npx",
    args: ["-y", "tmux-mcp", "--shell-type=zsh", "--socket=/tmp/tmux-node-bench.sock"],
    socketPath: "/tmp/tmux-node-bench.sock",
  },
];

interface MetricResult {
  metric: string;
  value: string;
  /** Lower is better unless noted. */
  unit: string;
}

interface BenchResult {
  server: string;
  language: string;
  metrics: MetricResult[];
  /** Set when a metric routine failed; the table renders the error in
      place of the value so the next session knows what to fix. */
  errors: string[];
}

// ───────────────────────────────────────────────────────────────────
// Metric routines (skeletons — fill in once the MCP client is wired)
// ───────────────────────────────────────────────────────────────────

async function measureColdStart(_server: ServerSpec): Promise<MetricResult> {
  // TODO (next session): spawn server, measure time from spawn() to first
  // `tools/list` response. Use perf_hooks `performance.now()`.
  return { metric: "Cold start (spawn → tools/list)", value: "TBD", unit: "ms" };
}

async function measureRoundTripIdle(_server: ServerSpec): Promise<MetricResult> {
  // TODO: 100× no-op (e.g. tmux list-sessions) → percentiles.
  return { metric: "Round-trip latency, idle (p50 / p95 / p99)", value: "TBD", unit: "ms" };
}

async function measureRoundTripWrite(_server: ServerSpec): Promise<MetricResult> {
  // TODO: 100× send-keys + capture-pane to verify, percentiles.
  return { metric: "Round-trip latency, write (p50 / p95)", value: "TBD", unit: "ms" };
}

async function measureThroughput(_server: ServerSpec): Promise<MetricResult> {
  // TODO: saturate with 10 parallel send-keys; total wallclock + error
  // count.
  return { metric: "Throughput (10 parallel sends, total wallclock)", value: "TBD", unit: "ms" };
}

async function measureMemory(_server: ServerSpec): Promise<MetricResult> {
  // TODO: ps -o rss= against the server PID every 5s for 60s; report
  // max / avg.
  return { metric: "Memory footprint (RSS max / avg over 60s)", value: "TBD", unit: "MB" };
}

async function measureCrashRecovery(_server: ServerSpec): Promise<MetricResult> {
  // TODO: kill the underlying tmux server mid-call; expect a clean MCP
  // error envelope, not a hang. Pass/fail.
  return { metric: "Crash recovery (clean error vs hang)", value: "TBD", unit: "pass|fail" };
}

async function measureToolSurface(_server: ServerSpec): Promise<MetricResult> {
  // TODO: diff tools/list JSON between the two servers; report tool
  // count + a short list of asymmetric tools.
  return { metric: "Tool surface (count / extras)", value: "TBD", unit: "tools" };
}

// ───────────────────────────────────────────────────────────────────
// Harness
// ───────────────────────────────────────────────────────────────────

type ServerHandle = ChildProcessByStdio<Writable, Readable, Readable>;

async function spawnServer(spec: ServerSpec): Promise<ServerHandle> {
  // Wire the stdio MCP client here next session. For now, spawn so the
  // harness still validates the binary is reachable.
  return spawn(spec.cmd, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function killServer(handle: ServerHandle): Promise<void> {
  if (!handle.killed) handle.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  if (!handle.killed) handle.kill("SIGKILL");
}

async function benchOne(spec: ServerSpec): Promise<BenchResult> {
  const errors: string[] = [];
  let server: ServerHandle | null = null;
  const metrics: MetricResult[] = [];
  try {
    server = await spawnServer(spec);
    metrics.push(await measureColdStart(spec));
    metrics.push(await measureRoundTripIdle(spec));
    metrics.push(await measureRoundTripWrite(spec));
    metrics.push(await measureThroughput(spec));
    metrics.push(await measureMemory(spec));
    metrics.push(await measureCrashRecovery(spec));
    metrics.push(await measureToolSurface(spec));
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (server) await killServer(server);
    // Tidy the per-server sockets so re-runs are hermetic.
    await fs.rm(spec.socketPath, { force: true }).catch(() => {});
  }
  return { server: spec.name, language: spec.language, metrics, errors };
}

// ───────────────────────────────────────────────────────────────────
// Renderer
// ───────────────────────────────────────────────────────────────────

function renderMarkdown(results: BenchResult[]): string {
  const metricNames = results[0]?.metrics.map((m) => m.metric) ?? [];
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
  lines.push("");
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const name of metricNames) {
    const cells: string[] = [name];
    const unit = results[0]?.metrics.find((m) => m.metric === name)?.unit ?? "";
    cells.push(unit);
    for (const r of results) {
      const m = r.metrics.find((mm) => mm.metric === name);
      cells.push(m ? m.value : "—");
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  for (const r of results) {
    if (r.errors.length > 0) {
      lines.push(`### ${r.server} — errors`);
      for (const e of r.errors) lines.push(`- ${e}`);
      lines.push("");
    }
  }
  return lines.join("\n");
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
