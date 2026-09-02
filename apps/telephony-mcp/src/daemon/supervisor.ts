/**
 * cloudflared supervisor (Phase D step 3) — `serve` owns the tunnel child
 * (D-c: one process to turn voice on, one lifetime).
 *
 * Pure state machine with injected deps, mirroring the ExecFileFn seam in
 * stores/secrets.ts. The default suite starts no tunnel (INV-14).
 *
 * INV-11: log the tunnel NAME, never the hostname or a URL. The token never
 * enters argv (`ps aux` is world-readable) — child env only (INV-12).
 * INV-10: the metrics/readiness listener binds loopback only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TunnelConfig } from "../config/schema.js";
import type { Clock, SecretProvider } from "../domain/ports.js";
import { log } from "../log.js";

export type TunnelState = "disabled" | "starting" | "ready" | "down" | "gave_up" | "stopped";

export interface SpawnedChild {
  pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
}

export interface SupervisorDeps {
  spawn: (bin: string, args: string[], opts: { env: Record<string, string> }) => SpawnedChild;
  fetchImpl: typeof fetch;
  clock: Clock;
  secrets: SecretProvider;
  /** State dir for the pidfile; injected so tests use a temp dir. */
  stateDir: string;
  /** Is this PID alive and a cloudflared? Injected for the stale-child test. */
  isCloudflaredPid?: (pid: number) => boolean;
  onStateChange?: (state: TunnelState) => void;
}

function defaultIsCloudflaredPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const out = execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="]).toString();
    return out.includes("cloudflared");
  } catch {
    return false;
  }
}

export class TunnelSupervisor {
  private child: SpawnedChild | null = null;
  private state: TunnelState = "disabled";
  private restarts = 0;
  private backoffMs: number;
  private stopping = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private cfg: TunnelConfig,
    private deps: SupervisorDeps,
  ) {
    this.backoffMs = cfg.restart.initialBackoffMs;
  }

  get status(): { state: TunnelState; restarts: number } {
    return { state: this.state, restarts: this.restarts };
  }

  private setState(state: TunnelState): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.onStateChange?.(state);
  }

  private pidfilePath(): string {
    return join(this.deps.stateDir, "cloudflared.pid");
  }

  /** Kill a stale child from a previous serve before spawning a fresh one. */
  private reapStaleChild(): void {
    const path = this.pidfilePath();
    if (!existsSync(path)) return;
    const pid = Number(readFileSync(path, "utf8").trim());
    const probe = this.deps.isCloudflaredPid ?? defaultIsCloudflaredPid;
    if (Number.isFinite(pid) && pid > 0 && probe(pid)) {
      log("warn", "tunnel_stale_child_killed", { pid });
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    rmSync(path, { force: true });
  }

  async start(): Promise<void> {
    if (!this.cfg.enabled) {
      this.setState("disabled");
      return;
    }
    this.stopping = false;
    this.reapStaleChild();
    await this.spawnOnce();
  }

  private async spawnOnce(): Promise<void> {
    if (this.stopping) return;
    this.setState("starting");
    const env: Record<string, string> = {
      TUNNEL_METRICS: `127.0.0.1:${this.cfg.metricsPort}`,
    };
    const args = ["tunnel", "--no-autoupdate"];
    if (this.cfg.credentialsFile) {
      args.push("run", "--credentials-file", this.cfg.credentialsFile);
    } else {
      const token = this.cfg.tokenRef ? await this.deps.secrets.get(this.cfg.tokenRef) : null;
      if (!token) {
        log("error", "tunnel_token_unresolvable", { tokenRef: this.cfg.tokenRef });
        this.setState("gave_up");
        return;
      }
      env.TUNNEL_TOKEN = token; // env only — NEVER argv (INV-12)
      args.push("run");
    }
    if (this.cfg.tunnelName) args.push(this.cfg.tunnelName);

    const child = this.deps.spawn(this.cfg.binPath, args, { env });
    this.child = child;
    if (child.pid) writeFileSync(this.pidfilePath(), String(child.pid), { mode: 0o600 });
    log("info", "tunnel_spawned", { tunnelName: this.cfg.tunnelName, pid: child.pid });

    child.once("exit", (code, signal) => {
      this.child = null;
      rmSync(this.pidfilePath(), { force: true });
      if (this.stopping) return;
      this.setState("down");
      this.restarts += 1;
      if (this.restarts >= this.cfg.restart.giveUpAfter) {
        // Crash-loop breaker: hammering Cloudflare is worse than being
        // visibly down. The gateway stays up, degraded (D-d).
        log("error", "tunnel_gave_up", { restarts: this.restarts, code, signal });
        this.setState("gave_up");
        return;
      }
      const jitter = Math.floor(Math.random() * this.backoffMs * 0.2);
      const delay = this.backoffMs + jitter;
      log("warn", "tunnel_restarting", { restarts: this.restarts, delayMs: delay, code });
      this.backoffMs = Math.min(this.backoffMs * 2, this.cfg.restart.maxBackoffMs);
      const timer = setTimeout(() => void this.spawnOnce(), delay);
      timer.unref();
      this.timers.push(timer);
    });

    await this.awaitReady();
    if (this.state === "ready") this.startHealthLoop();
  }

  /** Poll loopback /ready until 2xx or timeout; readiness never throws. */
  private async awaitReady(timeoutMs = 30_000): Promise<void> {
    const deadline = this.deps.clock.nowMs() + timeoutMs;
    while (this.deps.clock.nowMs() < deadline && !this.stopping && this.child) {
      if (await this.probeReady()) {
        this.backoffMs = this.cfg.restart.initialBackoffMs;
        this.setState("ready");
        log("info", "tunnel_ready", { tunnelName: this.cfg.tunnelName });
        return;
      }
      await new Promise((r) => {
        const t = setTimeout(r, 500);
        t.unref();
      });
    }
    if (this.state === "starting") this.setState("down");
  }

  private async probeReady(): Promise<boolean> {
    try {
      const res = await this.deps.fetchImpl(`http://127.0.0.1:${this.cfg.metricsPort}/ready`);
      return res.ok;
    } catch {
      return false;
    }
  }

  private startHealthLoop(): void {
    const timer = setInterval(() => {
      void this.probeReady().then((ok) => {
        if (this.stopping) return;
        if (!ok && this.state === "ready") {
          this.setState("down");
          log("warn", "tunnel_unhealthy", { tunnelName: this.cfg.tunnelName });
        } else if (ok && this.state === "down" && this.child) {
          this.setState("ready");
          log("info", "tunnel_recovered", { tunnelName: this.cfg.tunnelName });
        }
      });
    }, this.cfg.healthIntervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  /** SIGTERM, grace, SIGKILL; pidfile removed. Registered with shutdown. */
  async stop(graceMs = 5_000): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const child = this.child;
    if (child) {
      child.kill("SIGTERM");
      const exited = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), graceMs);
        t.unref();
        child.once("exit", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      if (!exited) child.kill("SIGKILL");
      this.child = null;
    }
    rmSync(this.pidfilePath(), { force: true });
    this.setState("stopped");
  }
}
