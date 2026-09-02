/**
 * Phase D verification table: config back-compat + the 403-trap superRefine
 * (1-4), renderPlist snapshot (5), supervisor state machine with injected
 * spawn/fetch/clock (6-12). No tunnel, no network, no launchctl (INV-14).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";
import { parseLaunchctlPrint, renderPlist } from "../src/daemon/launchd.js";
import {
  type SpawnedChild,
  type SupervisorDeps,
  type TunnelState,
  TunnelSupervisor,
} from "../src/daemon/supervisor.js";
import { FixedClock, testConfig } from "./helpers.js";

const TUNNEL_ON = {
  enabled: true,
  tunnelName: "telephony",
  hostname: "gw.test.invalid",
} as const;

describe("tunnel/daemon config (verification 1-4)", () => {
  it("1: a config with neither block parses unchanged; defaults land", () => {
    const cfg = testConfig();
    expect(cfg.tunnel.enabled).toBe(false);
    expect(cfg.tunnel.binPath).toBe("/opt/homebrew/bin/cloudflared");
    expect(cfg.tunnel.tokenRef).toBe("CLOUDFLARE_TUNNEL_TOKEN");
    expect(cfg.daemon.label).toBe("com.george43g.telephony-mcp");
    expect(cfg.daemon.keepAlive).toBe(true);
  });

  it("2: hostname ≠ publicBaseUrl host is a parse error (the 403 trap)", () => {
    const res = ConfigSchema.safeParse({
      ...rawConfig(),
      tunnel: { ...TUNNEL_ON, hostname: "other.example.com" },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toMatch(/403s every Twilio webhook/);
    }
  });

  it("3: tunnel.enabled with no publicBaseUrl is a parse error", () => {
    const raw = rawConfig();
    (raw.server as Record<string, unknown>).publicBaseUrl = undefined;
    const res = ConfigSchema.safeParse({ ...raw, tunnel: TUNNEL_ON });
    expect(res.success).toBe(false);
  });

  it("4: an unknown key inside tunnel is a parse error (.strict())", () => {
    const res = ConfigSchema.safeParse({
      ...rawConfig(),
      tunnel: { ...TUNNEL_ON, hostnme: "typo.example.com" },
    });
    expect(res.success).toBe(false);
  });

  it("matching hostname parses", () => {
    const res = ConfigSchema.safeParse({ ...rawConfig(), tunnel: TUNNEL_ON });
    expect(res.success).toBe(true);
  });
});

/** The raw (pre-parse) shape testConfig() builds from. */
function rawConfig(): Record<string, unknown> {
  return {
    server: { publicBaseUrl: "https://gw.test.invalid", publicPort: 18790, adminPort: 18791 },
    telephony: testConfig().telephony,
    llm: testConfig().llm,
    voice: testConfig().voice,
    recipients: {},
    profiles: { default: { systemPrompt: "x", greeting: "y" } },
    limits: {},
  };
}

describe("renderPlist (verification 5)", () => {
  it("bakes absolute paths, serve verb, KeepAlive, throttle and both log paths", () => {
    const xml = renderPlist({
      label: "com.george43g.telephony-mcp",
      nodeBin: "/opt/node/bin/node",
      cliJs: "/repo/apps/telephony-mcp/dist/cli.js",
      runAtLoad: true,
      keepAlive: true,
      logDir: "/Users/x/Library/Logs/telephony-mcp",
      throttleSeconds: 30,
    });
    expect(xml).toContain("<string>/opt/node/bin/node</string>");
    expect(xml).toContain("<string>/repo/apps/telephony-mcp/dist/cli.js</string>");
    expect(xml).toContain("<string>serve</string>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("<key>ThrottleInterval</key><integer>30</integer>");
    expect(xml).toContain("launchd.out.log");
    expect(xml).toContain("launchd.err.log");
  });

  it("parses launchctl print output tolerantly", () => {
    const s = parseLaunchctlPrint("state = running\n\tpid = 4242\n\truns = 3\n");
    expect(s.pid).toBe(4242);
    expect(s.runs).toBe(3);
    expect(s.lastExitStatus).toBeNull();
  });
});

describe("TunnelSupervisor (verification 6-12)", () => {
  let dir: string;
  let clock: FixedClock;
  let spawned: Array<{ bin: string; args: string[]; env: Record<string, string> }>;
  let children: FakeChild[];
  let readyOk: boolean;
  let states: TunnelState[];

  class FakeChild implements SpawnedChild {
    pid = 40000 + children.length;
    killed: string[] = [];
    private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
    kill(signal?: NodeJS.Signals): boolean {
      this.killed.push(signal ?? "SIGTERM");
      return true;
    }
    once(_e: "exit", l: (code: number | null, signal: string | null) => void): void {
      this.exitListeners.push(l);
    }
    exit(code: number | null): void {
      const ls = this.exitListeners;
      this.exitListeners = [];
      for (const l of ls) l(code, null);
    }
  }

  function cfg(overrides: Record<string, unknown> = {}) {
    return ConfigSchema.parse({
      ...rawConfig(),
      tunnel: {
        ...TUNNEL_ON,
        restart: { initialBackoffMs: 100, maxBackoffMs: 1000, giveUpAfter: 3 },
        ...overrides,
      },
    }).tunnel;
  }

  function makeDeps(overrides: Partial<SupervisorDeps> = {}): SupervisorDeps {
    return {
      spawn: (bin, args, opts) => {
        spawned.push({ bin, args, env: opts.env });
        const c = new FakeChild();
        children.push(c);
        return c;
      },
      fetchImpl: (async () =>
        new Response("ok", { status: readyOk ? 200 : 503 })) as unknown as typeof fetch,
      clock,
      secrets: { get: async (name) => (name === "CLOUDFLARE_TUNNEL_TOKEN" ? "tok-secret" : null) },
      stateDir: dir,
      isCloudflaredPid: () => false,
      onStateChange: (s) => states.push(s),
      ...overrides,
    };
  }

  /** stop() uses a real-shaped grace timeout; under fake timers, advance past it. */
  async function stopUnderFakeTimers(sup: TunnelSupervisor): Promise<void> {
    const p = sup.stop(0);
    await vi.advanceTimersByTimeAsync(10);
    await p;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tel-daemon-"));
    clock = new FixedClock();
    spawned = [];
    children = [];
    states = [];
    readyOk = true;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("8+10: spawns with token in ENV only, never argv; ready on 200", async () => {
    const sup = new TunnelSupervisor(cfg(), makeDeps());
    await sup.start();
    expect(sup.status.state).toBe("ready");
    const s = spawned[0];
    expect(s?.env.TUNNEL_TOKEN).toBe("tok-secret");
    expect(s?.args.join(" ")).not.toContain("tok-secret"); // INV-12: zero argv positions
    expect(s?.args).toContain("telephony");
    expect(s?.env.TUNNEL_METRICS).toMatch(/^127\.0\.0\.1:/);
    await stopUnderFakeTimers(sup);
  });

  it("8b: not ready while /ready returns 503", async () => {
    readyOk = false;
    const sup = new TunnelSupervisor(cfg(), makeDeps());
    const startP = sup.start();
    // let the poll loop run a few rounds then time out via the fake clock
    await vi.advanceTimersByTimeAsync(400);
    clock.advance(31_000);
    await vi.advanceTimersByTimeAsync(1000);
    await startP;
    expect(sup.status.state).not.toBe("ready");
    await stopUnderFakeTimers(sup);
  });

  it("6+7: exponential backoff restarts, then the crash-loop breaker gives up; nothing throws", async () => {
    const sup = new TunnelSupervisor(cfg(), makeDeps());
    await sup.start();
    expect(spawned).toHaveLength(1);
    children[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(150); // ≥100ms + jitter
    expect(spawned).toHaveLength(2);
    children[1]?.exit(1);
    await vi.advanceTimersByTimeAsync(300); // doubled: ≥200ms
    expect(spawned).toHaveLength(3);
    children[2]?.exit(1); // third exit → restarts === giveUpAfter → gave_up
    await vi.advanceTimersByTimeAsync(5000);
    expect(spawned).toHaveLength(3); // no further spawn
    expect(sup.status.state).toBe("gave_up");
    expect(sup.status.restarts).toBe(3);
  });

  it("9: stop() SIGTERMs, escalates to SIGKILL after grace, removes the pidfile", async () => {
    const sup = new TunnelSupervisor(cfg(), makeDeps());
    await sup.start();
    expect(existsSync(join(dir, "cloudflared.pid"))).toBe(true);
    const stopP = sup.stop(1000);
    await vi.advanceTimersByTimeAsync(1100); // grace expires; child never exited
    await stopP;
    expect(children[0]?.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(join(dir, "cloudflared.pid"))).toBe(false);
    expect(sup.status.state).toBe("stopped");
  });

  it("12: a live pidfile pointing at a running cloudflared is killed before respawn", async () => {
    writeFileSync(join(dir, "cloudflared.pid"), "39999");
    const probed: number[] = [];
    const killed: number[] = [];
    const origKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: unknown) => {
      if (pid === 39999) {
        killed.push(pid);
        return true;
      }
      return origKill(pid, sig as never);
    }) as typeof process.kill);
    try {
      const sup = new TunnelSupervisor(
        cfg(),
        makeDeps({
          isCloudflaredPid: (pid) => {
            probed.push(pid);
            return true;
          },
        }),
      );
      await sup.start();
      expect(probed).toEqual([39999]);
      expect(killed).toEqual([39999]);
      await stopUnderFakeTimers(sup);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("11: no emitted log line contains the hostname or an https tunnel URL", async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const sup = new TunnelSupervisor(cfg(), makeDeps());
      await sup.start();
      children[0]?.exit(1);
      await vi.advanceTimersByTimeAsync(200);
      await stopUnderFakeTimers(sup);
    } finally {
      process.stderr.write = orig;
    }
    const all = lines.join("");
    expect(all).not.toContain("gw.test.invalid"); // INV-11
    expect(all).not.toContain("https://");
    expect(all).toContain("telephony"); // the NAME is loggable
  });

  it("token unresolvable → gave_up without spawning (INV-12 fail-closed)", async () => {
    const sup = new TunnelSupervisor(cfg(), makeDeps({ secrets: { get: async () => null } }));
    await sup.start();
    expect(spawned).toHaveLength(0);
    expect(sup.status.state).toBe("gave_up");
  });
});
