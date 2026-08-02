#!/usr/bin/env tsx
/**
 * TUI / data-path stress harness.
 *
 * Boots a headless workload (scripts/stress-tui-workload.ts) against a
 * heavy synthetic fixture (top 5 threads × 20k messages each + 1200
 * long-tail threads), and externally samples RSS / CPU / event-loop p99
 * lag each second.
 *
 * Why headless instead of the live TUI binary: spawning Ink from a child
 * process whose stdin is a pipe (always the case in CI) fails because Ink
 * needs raw mode. macOS BSD `script(1)` would normally provide a pty, but
 * it itself refuses to start with non-tty stdin ("Operation not supported
 * on socket"). The interesting bugs in CI scope — memory leaks, query
 * regressions, watchdog correctness — live in the data path which the
 * workload exercises directly. Render-layer bugs are pinned by unit
 * tests (see tests/use-mouse-regression.test.ts).
 *
 * Emits machine-readable JSON for CI artefact upload and GitHub-Actions
 * `::warning` / `::error` annotations on threshold breaches.
 *
 * Usage:
 *   pnpm fixtures:stress   # one-time, generates fixtures-stress/
 *   pnpm stress:tui        # run harness against it
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ── Config ────────────────────────────────────────────────────────────────

const FIXTURE_DIR = process.env.IMSG_STRESS_FIXTURE_DIR ?? "fixtures-stress";
const DURATION_S = Number(process.env.IMSG_STRESS_TUI_DURATION_S ?? 60);
const SAMPLE_INTERVAL_MS = 1_000;

// Thresholds. Tuned for macos-latest M-series CI; override via env vars.
const RSS_FAIL_MB = Number(process.env.IMSG_STRESS_RSS_FAIL_MB ?? 800);
const RSS_WARN_MB = Number(process.env.IMSG_STRESS_RSS_WARN_MB ?? 500);
const LAG_FAIL_MS = Number(process.env.IMSG_STRESS_LAG_FAIL_MS ?? 2_000);
const LAG_WARN_MS = Number(process.env.IMSG_STRESS_LAG_WARN_MS ?? 750);
const CPU_FAIL_PCT = Number(process.env.IMSG_STRESS_CPU_FAIL_PCT ?? 95);
const CPU_FAIL_SAMPLES = Number(process.env.IMSG_STRESS_CPU_WINDOW ?? 20);
const WARMUP_SAMPLES = Number(process.env.IMSG_STRESS_WARMUP_SAMPLES ?? 5);

// ── Helpers ───────────────────────────────────────────────────────────────

function ghaWarn(msg: string): void {
  console.log(`::warning::${msg}`);
}
function ghaError(msg: string): void {
  console.log(`::error::${msg}`);
}

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolveCmd) => {
    const p = spawn(cmd, args, { stdio: "pipe" });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
    });
    p.on("close", () => resolveCmd(out));
    p.on("error", () => resolveCmd(""));
  });
}

async function sampleProcess(pid: number): Promise<{ rssMb: number; cpuPct: number }> {
  const out = await runCmd("ps", ["-p", String(pid), "-o", "rss=,%cpu="]);
  const parts = out.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { rssMb: 0, cpuPct: 0 };
  return {
    rssMb: Number(parts[0]) / 1024,
    cpuPct: Number(parts[1]),
  };
}

interface WatchdogStateSnapshot {
  eventLoopP99Ms: number;
  rssMb: number;
  killReason: string | null;
}

function readWatchdogState(path: string): WatchdogStateSnapshot | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const fixturePath = resolve(FIXTURE_DIR, "chat.db");
  if (!existsSync(fixturePath)) {
    ghaError(`fixture not found: ${fixturePath} — run 'pnpm fixtures:stress' first`);
    return 2;
  }

  const statePath = join(tmpdir(), `imsg-stress-${process.pid}.json`);
  try {
    unlinkSync(statePath);
  } catch {}

  console.log(`stress-tui: fixture=${FIXTURE_DIR}  duration=${DURATION_S}s`);
  console.log(`            RSS warn ${RSS_WARN_MB}MB / fail ${RSS_FAIL_MB}MB`);
  console.log(`            lag warn ${LAG_WARN_MS}ms / fail ${LAG_FAIL_MS}ms`);
  console.log(`            CPU fail >= ${CPU_FAIL_PCT}% for ${CPU_FAIL_SAMPLES} samples`);

  // Spawn the headless workload — same data path the TUI uses.
  const workload = spawn("node", ["--import", "tsx", resolve("scripts/stress-tui-workload.ts")], {
    env: {
      ...process.env,
      IMSG_STRESS_FIXTURE_DIR: FIXTURE_DIR,
      IMSG_STRESS_TUI_DURATION_S: String(DURATION_S),
      VITE_IMSG_DB_PATH: resolve(FIXTURE_DIR, "chat.db"),
      VITE_CONTACTS_DB_PATH: resolve(FIXTURE_DIR, "AddressBook", "AddressBook-v22.abcddb"),
      VITE_SLUGS_DB_PATH: resolve(FIXTURE_DIR, "slugs.db"),
      IMSG_WATCHDOG_STATE_PATH: statePath,
      IMSG_EVENT_LOOP_SAMPLE_MS: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!workload.pid) {
    ghaError("failed to spawn workload");
    return 1;
  }
  // Forward workload output (per-iteration timings) to the harness output.
  workload.stdout?.on("data", (d) => process.stdout.write(`  [w] ${d}`));
  workload.stderr?.on("data", (d) => process.stderr.write(`  [w-err] ${d}`));

  let workloadExited = false;
  let workloadExitCode: number | null = null;
  workload.on("exit", (code) => {
    workloadExited = true;
    workloadExitCode = code;
  });

  console.log(`stress-tui: workload pid ${workload.pid}`);

  interface Sample {
    t: number;
    rssMb: number;
    cpuPct: number;
    lagP99Ms: number;
  }
  const samples: Sample[] = [];
  let peakRss = 0;
  let peakLag = 0;
  let highCpuStreak = 0;
  let peakHighCpuStreak = 0;
  let killReason: string | null = null;
  const start = Date.now();
  const deadline = start + (DURATION_S + 5) * 1_000; // +5s grace for workload teardown

  while (Date.now() < deadline && !workloadExited && !killReason) {
    await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
    if (workloadExited) break;

    const { rssMb, cpuPct } = await sampleProcess(workload.pid);
    const wd = readWatchdogState(statePath);
    const lagP99Ms = wd?.eventLoopP99Ms ?? 0;
    // Take the larger of ps-RSS and self-reported watchdog RSS.
    const rssCombined = Math.max(rssMb, wd?.rssMb ?? 0);

    samples.push({ t: Date.now() - start, rssMb: rssCombined, cpuPct, lagP99Ms });
    if (rssCombined > peakRss) peakRss = rssCombined;
    if (lagP99Ms > peakLag) peakLag = lagP99Ms;

    if (cpuPct >= CPU_FAIL_PCT) {
      highCpuStreak += 1;
      if (highCpuStreak > peakHighCpuStreak) peakHighCpuStreak = highCpuStreak;
    } else {
      highCpuStreak = 0;
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    const past_warmup = samples.length > WARMUP_SAMPLES;
    process.stdout.write(
      `[${String(elapsed).padStart(3)}s] RSS ${rssCombined.toFixed(1).padStart(6)}MB  ` +
        `CPU ${cpuPct.toFixed(1).padStart(5)}%  lag-p99 ${lagP99Ms.toFixed(0).padStart(5)}ms  ` +
        `cpu-streak ${highCpuStreak}${past_warmup ? "" : "  (warmup)"}\n`,
    );

    if (past_warmup) {
      if (lagP99Ms >= LAG_FAIL_MS) {
        killReason = `event-loop p99 lag ${lagP99Ms.toFixed(0)}ms >= fail ${LAG_FAIL_MS}ms`;
      } else if (rssCombined >= RSS_FAIL_MB) {
        killReason = `RSS ${rssCombined.toFixed(1)}MB >= fail ${RSS_FAIL_MB}MB`;
      } else if (highCpuStreak >= CPU_FAIL_SAMPLES) {
        killReason = `CPU >= ${CPU_FAIL_PCT}% for ${highCpuStreak} samples (>= ${CPU_FAIL_SAMPLES})`;
      }
    }
    if (wd?.killReason && !killReason) {
      killReason = `workload self-killed: ${wd.killReason}`;
    }
  }

  if (!workloadExited) {
    workload.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1_000));
    if (!workloadExited) workload.kill("SIGKILL");
  }

  // ── Report ──────────────────────────────────────────────────────────────

  const peakCpu = samples.reduce((m, s) => Math.max(m, s.cpuPct), 0);
  const finalRss = samples.length ? samples[samples.length - 1].rssMb : 0;

  const report = {
    durationS: DURATION_S,
    samples: samples.length,
    workloadExitCode,
    peakRssMb: peakRss,
    finalRssMb: finalRss,
    peakCpuPct: peakCpu,
    peakHighCpuStreak,
    peakLagP99Ms: peakLag,
    thresholds: {
      RSS_FAIL_MB,
      RSS_WARN_MB,
      LAG_FAIL_MS,
      LAG_WARN_MS,
      CPU_FAIL_PCT,
      CPU_FAIL_SAMPLES,
    },
    killReason,
    series: samples,
  };
  writeFileSync("stress-tui-report.json", JSON.stringify(report, null, 2));

  console.log("\n=== stress-tui report ===");
  console.log(`samples       : ${samples.length}`);
  console.log(`workload exit : ${workloadExitCode ?? "n/a"}`);
  console.log(`peak RSS      : ${peakRss.toFixed(1)} MB`);
  console.log(`final RSS     : ${finalRss.toFixed(1)} MB`);
  console.log(`peak CPU      : ${peakCpu.toFixed(1)} %`);
  console.log(`peak CPU run  : ${peakHighCpuStreak} samples >= ${CPU_FAIL_PCT}%`);
  console.log(`peak lag p99  : ${peakLag.toFixed(0)} ms`);
  console.log(`report file   : stress-tui-report.json`);

  try {
    unlinkSync(statePath);
  } catch {}

  if (killReason) {
    ghaError(`stress-tui FAIL: ${killReason}`);
    return 1;
  }
  if (peakRss >= RSS_WARN_MB) ghaWarn(`peak RSS ${peakRss.toFixed(1)}MB >= warn ${RSS_WARN_MB}MB`);
  if (peakLag >= LAG_WARN_MS) ghaWarn(`peak lag ${peakLag.toFixed(0)}ms >= warn ${LAG_WARN_MS}ms`);

  console.log("\nresult: PASS");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
