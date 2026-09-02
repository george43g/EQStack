#!/usr/bin/env node
/**
 * telephony-mcp CLI (`tel`) — entrypoints over the same domain services:
 *   tel mcp     stdio MCP server (stderr-only logging)
 *   tel serve   public Twilio listener + localhost admin listener
 *   tel console interactive REPL over the shared command registry
 *   tel …       operator commands (doctor, call, watch,
 *                     recording play|export|delete, history …)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEnvFromFlags,
  bindEnvFlags,
  buildProgram,
  type EnvFlagBinding,
  printAuto,
  printJson,
  runRepl,
} from "@george43g/cli-kit";
import { buildDispatcher } from "@george43g/mcp-kit";
import { ZodError, type z } from "zod";
import { AdminClient, GatewayUnavailableError } from "./client/admin-client.js";
import { buildClientRegistry } from "./commands/bind-client.js";
import { deleteRecording, placeCall } from "./commands/specs.js";
import { type Config, loadConfigFile } from "./config/schema.js";
import {
  defaultLaunchctl,
  expandHome,
  guiDomain,
  parseLaunchctlPrint,
  plistPath,
  plistSpecFromConfig,
  renderPlist,
} from "./daemon/launchd.js";
import { startGateway } from "./gateway/gateway.js";
import { setLogLevel } from "./log.js";
import { runStdioMcp } from "./mcp/server.js";
import { migrateLegacyState } from "./migrate-state.js";
import { configPath, dbPath, recordingsDir } from "./paths.js";
import { EncryptedRecordingStore } from "./stores/recording-store.js";
import { EnvKeychainSecretProvider } from "./stores/secrets.js";
import { SqliteStore } from "./stores/sqlite-store.js";
import { VERSION } from "./version.js";

function loadConfig(): Config {
  return loadConfigFile(configPath());
}

function admin(cfg: Config): AdminClient {
  return new AdminClient(cfg.server.adminPort);
}

function fail(err: unknown): never {
  console.error(`tel: ${(err as Error).message}`);
  process.exit(1);
}

/**
 * Parse assembled CLI args with a command spec's input schema (Phase B step 9:
 * the hand-validation that was ledger rows L-9/L-10 now lives in the shared
 * contracts). The first Zod issue surfaces through fail() as one line.
 */
function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const field = issue && issue.path.length > 0 ? issue.path.join(".") : "input";
      fail(new Error(`${field}: ${issue?.message ?? "invalid input"}`));
    }
    throw err;
  }
}

const program = buildProgram({
  name: "tel",
  description: "Agent-initiated real-time phone calls (MCP + gateway)",
  version: VERSION,
});

/** Every TEL_* env var is also a flag (cli-kit binder; ledger L-8 closed). */
const ENV_BINDINGS: EnvFlagBinding[] = [
  { envVar: "TEL_CONFIG", description: "Path to config.json" },
  { envVar: "TEL_STATE_DIR", description: "State directory override" },
  { envVar: "TEL_LOG_LEVEL", description: "Log level: debug|info|warn|error" },
  { envVar: "TEL_KEYCHAIN_SERVICE", description: "Keychain service for secret lookups" },
];
bindEnvFlags(program, ENV_BINDINGS, { stripPrefixes: ["TEL_"] });
program.hook("preAction", () => {
  applyEnvFromFlags(program, ENV_BINDINGS, { stripPrefixes: ["TEL_"] });
  const lvl = process.env.TEL_LOG_LEVEL;
  if (lvl === "debug" || lvl === "info" || lvl === "warn" || lvl === "error") setLogLevel(lvl);
});

program
  .command("mcp")
  .description("Run the stdio MCP server")
  .action(async () => {
    try {
      const cfg = loadConfig();
      // mcp-kit lifecycle: shutdown traps, stdin-EOF, orphan watch, watchdog,
      // heap monitor (Phase A ledger L-5; long-poll feeds the watchdog via the
      // dispatcher's noteActivity — pinned in tests/mcp.integration.test.ts).
      await runStdioMcp({ cfg, admin: admin(cfg) });
    } catch (err) {
      fail(err);
    }
  });

program
  .command("console")
  .description("Interactive REPL over the shared command registry (same tools as the MCP server)")
  .action(async () => {
    try {
      const cfg = loadConfig();
      const registry = buildClientRegistry({
        admin: admin(cfg),
        // Same default the MCP server uses: read-only sqlite, or null until first serve.
        openReadStore: () =>
          existsSync(dbPath()) ? new SqliteStore(dbPath(), { readonly: true }) : null,
      });
      const dispatch = buildDispatcher({ registry, engineLabel: () => "ts" });
      await runRepl({
        prompt: "tel> ",
        dispatcher: {
          listTools: () =>
            registry.tools.map((t) => ({ name: t.name, description: t.description })),
          callTool: (name, args) => dispatch(name, args),
        },
      });
    } catch (err) {
      fail(err);
    }
  });

const daemon = program
  .command("daemon")
  .description("Manage the launchd LaunchAgent that keeps `tel serve` running (D-9/D-37)");

function daemonPaths(cfg: Config) {
  const cliJs = fileURLToPath(import.meta.url);
  const spec = plistSpecFromConfig(cfg.daemon, cliJs);
  return { spec, path: plistPath(cfg.daemon.label) };
}

daemon
  .command("install")
  .description("Render the LaunchAgent plist and bootstrap it")
  .action(async () => {
    try {
      const cfg = loadConfig();
      const { spec, path } = daemonPaths(cfg);
      if (!spec.cliJs.endsWith(".js")) {
        fail(
          new Error(
            "daemon install must run from the built CLI (pnpm build; node dist/cli.js daemon install) — launchd cannot execute TypeScript",
          ),
        );
      }
      mkdirSync(dirname(path), { recursive: true });
      mkdirSync(spec.logDir, { recursive: true });
      writeFileSync(path, renderPlist(spec));
      await defaultLaunchctl(["bootstrap", guiDomain(), path]);
      console.error(`installed ${cfg.daemon.label} (${path})`);
    } catch (err) {
      fail(err);
    }
  });

daemon
  .command("uninstall")
  .description("Boot the agent out and remove the plist")
  .action(async () => {
    try {
      const cfg = loadConfig();
      const { path } = daemonPaths(cfg);
      await defaultLaunchctl(["bootout", `${guiDomain()}/${cfg.daemon.label}`]).catch(() => {});
      rmSync(path, { force: true });
      console.error(`uninstalled ${cfg.daemon.label}`);
    } catch (err) {
      fail(err);
    }
  });

daemon
  .command("start")
  .description("Kickstart the agent")
  .action(async () => {
    try {
      const cfg = loadConfig();
      await defaultLaunchctl(["kickstart", `${guiDomain()}/${cfg.daemon.label}`]);
      console.error("started");
    } catch (err) {
      fail(err);
    }
  });

daemon
  .command("restart")
  .description("Kill and respawn the agent")
  .action(async () => {
    try {
      const cfg = loadConfig();
      await defaultLaunchctl(["kickstart", "-k", `${guiDomain()}/${cfg.daemon.label}`]);
      console.error("restarted");
    } catch (err) {
      fail(err);
    }
  });

daemon
  .command("stop")
  .description("Boot the agent out (until next install/login)")
  .action(async () => {
    try {
      const cfg = loadConfig();
      await defaultLaunchctl(["bootout", `${guiDomain()}/${cfg.daemon.label}`]);
      console.error("stopped");
    } catch (err) {
      fail(err);
    }
  });

daemon
  .command("status")
  .description("launchd + gateway + tunnel, one line per layer")
  .action(async () => {
    const cfg = loadConfig();
    let launchdLine = "not loaded";
    try {
      const { stdout } = await defaultLaunchctl(["print", `${guiDomain()}/${cfg.daemon.label}`]);
      const s = parseLaunchctlPrint(stdout);
      launchdLine = `pid=${s.pid ?? "-"} lastExit=${s.lastExitStatus ?? "-"} runs=${s.runs ?? "?"}`;
    } catch {
      // stays "not loaded"
    }
    console.log(`launchd  ${launchdLine}`);
    try {
      const h = await admin(cfg).health();
      console.log(`gateway  up v${h.version} activeCalls=${h.activeCalls}`);
    } catch {
      console.log("gateway  down (nothing on the admin port)");
    }
    if (cfg.tunnel.enabled) {
      try {
        const res = await fetch(`http://127.0.0.1:${cfg.tunnel.metricsPort}/ready`);
        console.log(`tunnel   ${res.ok ? "ready" : `not ready (HTTP ${res.status})`}`);
      } catch {
        console.log("tunnel   down (no /ready listener)");
      }
    } else {
      console.log("tunnel   disabled in config");
    }
  });

daemon
  .command("logs")
  .description("Tail the daemon's structured stderr log")
  .option("--follow", "keep following", false)
  .option("--lines <n>", "how many lines", "100")
  .action(async (opts: { follow: boolean; lines: string }) => {
    const cfg = loadConfig();
    const file = join(expandHome(cfg.daemon.logDir), "launchd.err.log");
    const args = ["-n", opts.lines, ...(opts.follow ? ["-f"] : []), file];
    const child = spawn("/usr/bin/tail", args, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("tunnel-status")
  .description("Named-tunnel state (prints the tunnel NAME, never the hostname)")
  .action(async () => {
    const cfg = loadConfig();
    if (!cfg.tunnel.enabled) {
      console.log("tunnel disabled in config");
      return;
    }
    console.log(`name: ${cfg.tunnel.tunnelName ?? "-"}`);
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.tunnel.metricsPort}/ready`);
      console.log(`local /ready: ${res.ok ? "ready" : `HTTP ${res.status}`}`);
    } catch {
      console.log("local /ready: down");
    }
  });

program
  .command("serve")
  .description("Run the telephony gateway (public webhook/WS listener + localhost admin)")
  .action(async () => {
    try {
      const cfg = loadConfig();
      const gateway = await startGateway(cfg);
      const shutdown = async () => {
        await gateway.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("doctor")
  .description("Check config, state, secrets presence, and gateway health (offline-safe)")
  .action(async () => {
    const results: Array<{ check: string; ok: boolean; detail: string }> = [];
    const push = (check: string, ok: boolean, detail = "") => results.push({ check, ok, detail });

    let cfg: Config | null = null;
    try {
      cfg = loadConfig();
      push("config", true, configPath());
      push(
        "publicBaseUrl",
        Boolean(cfg.server.publicBaseUrl),
        cfg.server.publicBaseUrl
          ? "set"
          : "missing — serve will refuse to start (enable tunnel.* or set it manually)",
      );
      if (cfg.tunnel.enabled) {
        push(
          "cloudflared",
          existsSync(cfg.tunnel.binPath),
          existsSync(cfg.tunnel.binPath) ? cfg.tunnel.binPath : `missing at ${cfg.tunnel.binPath}`,
        );
        const tokenOk = cfg.tunnel.tokenRef
          ? (await new EnvKeychainSecretProvider().get(cfg.tunnel.tokenRef)) !== null
          : cfg.tunnel.credentialsFile !== null;
        push(
          "tunnel token",
          tokenOk,
          tokenOk ? "resolvable" : `cannot resolve ${cfg.tunnel.tokenRef}`,
        );
        // INV-11: never print the hostname; the parse-time superRefine already
        // guarantees it matches publicBaseUrl, so report only the guarantee.
        push("tunnel hostname", true, "matches publicBaseUrl (enforced at parse)");
      }
      push(
        "recipients",
        true, // informational since Phase C (INV-2): aliases are nicknames, not permissions
        `${Object.keys(cfg.recipients).length} configured (aliases optional — any E.164 dials)`,
      );
    } catch (err) {
      push("config", false, (err as Error).message);
    }

    push("state db", existsSync(dbPath()), dbPath());

    if (cfg) {
      const secrets = new EnvKeychainSecretProvider();
      const refs = [
        cfg.telephony.accountSidRef,
        cfg.telephony.apiKeyRef,
        cfg.telephony.apiSecretRef,
        cfg.telephony.authTokenRef,
        ...(cfg.llm.apiKeyRef ? [cfg.llm.apiKeyRef] : []),
      ];
      for (const ref of refs) {
        const value = await secrets.get(ref);
        push(
          `secret ${ref}`,
          value !== null,
          value !== null ? "resolvable" : "not in env or keychain",
        );
      }
      try {
        const health = await admin(cfg).health();
        push("gateway", health.ok, `v${health.version}, ${health.activeCalls} active call(s)`);
      } catch (err) {
        push(
          "gateway",
          false,
          err instanceof GatewayUnavailableError ? "not running" : (err as Error).message,
        );
      }
    }

    for (const r of results) {
      console.log(`${r.ok ? "✓" : "✗"} ${r.check}${r.detail ? ` — ${r.detail}` : ""}`);
    }
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  });

program
  .command("call")
  .description("Place a phone call (REAL, PAID) — alias or any E.164; --dry-run previews")
  .argument("<to>", "configured recipient alias OR raw E.164, e.g. +61400000000")
  .requiredOption("--objective <text>", "what the call should achieve")
  .option("--context <text>", "extra context for the LLM")
  .option("--profile <name>", "call profile")
  .option("--record", "request recording (subject to recipient policy)")
  .option("--no-record", "request no recording")
  .option(
    "--mode <mode>",
    "conversation driver: byo-model (default; legacy alias llm) | direct (host replies via say)",
  )
  .option("--dry-run", "preview the resolved plan without dialing", false)
  .option("--idempotency-key <key>", "override the derived dedupe key")
  .action(async (to: string, opts) => {
    try {
      // D-43: invoking is consent — no --yes. --dry-run is the preview path.
      const input = parseInput(placeCall.input, {
        to,
        objective: opts.objective,
        ...(opts.context ? { context: opts.context } : {}),
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(opts.record !== undefined ? { record: opts.record } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.dryRun ? { dryRun: true } : {}),
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
      const cfg = loadConfig();
      const result = await admin(cfg).placeCall(input);
      printJson(result);
      if (!("plan" in result)) console.error(`\nWatch live: tel watch`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("say")
  .description("Speak text verbatim into a live call (direct-mode reply path)")
  .argument("<callId>", "live call id")
  .argument("<text>", "text to speak")
  .action(async (callId: string, text: string) => {
    try {
      const cfg = loadConfig();
      await admin(cfg).say(callId, text);
      printJson({ ok: true, spokenChars: text.length });
    } catch (err) {
      fail(err);
    }
  });

program
  .command("watch")
  .description("Tail live events from the gateway (SSE)")
  .option("--after <id>", "start after global event id", "0")
  .action(async (opts: { after: string }) => {
    try {
      const cfg = loadConfig();
      const res = await fetch(
        `http://127.0.0.1:${cfg.server.adminPort}/events?after=${Number(opts.after)}`,
        { headers: { Accept: "text/event-stream" } },
      ).catch(() => {
        throw new GatewayUnavailableError(cfg.server.adminPort);
      });
      if (!res.body) fail(new Error("no event stream"));
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        process.stdout.write(decoder.decode(chunk, { stream: true }));
      }
    } catch (err) {
      fail(err);
    }
  });

const history = program.command("history").description("Browse call history (read-only)");

function withReadStore<T>(fn: (s: SqliteStore) => T): T {
  if (!existsSync(dbPath())) fail(new Error("no call history yet (state database does not exist)"));
  const store = new SqliteStore(dbPath(), { readonly: true });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

history
  .command("list")
  .description("List calls, newest first")
  .option("--limit <n>", "max rows", "20")
  .action((opts: { limit: string }) => {
    const calls = withReadStore((s) => s.listCalls({ limit: Number(opts.limit) }));
    printAuto(
      calls,
      {
        head: ["id", "to", "alias", "status", "created", "ended"],
        rows: (c) => [
          c.id,
          `…${c.numberSuffix}`,
          c.recipientAlias,
          c.status,
          new Date(c.createdAtMs).toISOString(),
          c.endedAtMs ? new Date(c.endedAtMs).toISOString() : "—",
        ],
      },
      program.opts(),
    );
  });

history
  .command("show")
  .description("Show one call with timings and recordings")
  .argument("<callId>")
  .action((callId: string) => {
    printJson(
      withReadStore((s) => ({
        call: s.getCall(callId),
        timings: s.getTimings(callId),
        recordings: s.getRecordingsForCall(callId),
        events: s.getEvents(callId, 0, 500),
      })),
    );
  });

history
  .command("transcript")
  .description("Print a call transcript")
  .argument("<callId>")
  .action((callId: string) => {
    const transcript = withReadStore((s) => s.getTranscript(callId));
    for (const u of transcript) {
      console.log(`[turn ${u.turn}] ${u.role}${u.interrupted ? " (interrupted)" : ""}: ${u.text}`);
    }
  });

history
  .command("search")
  .description("Full-text search transcripts and call metadata")
  .argument("<query>")
  .action((query: string) => {
    printJson(
      withReadStore((s) => ({
        calls: s.searchCalls(query),
        utterances: s.searchTranscripts(query),
      })),
    );
  });

const recording = program
  .command("recording")
  .description("Manage encrypted recordings (local playback only)");

recording
  .command("play")
  .description("Decrypt to a private temp file and play (afplay); temp file is removed after")
  .argument("<recordingSid>")
  .action(async (recordingSid: string) => {
    try {
      const store = new EncryptedRecordingStore(recordingsDir());
      const plain = await store.load(recordingSid);
      const dir = mkdtempSync(join(tmpdir(), "tel-play-"));
      const wav = join(dir, `${recordingSid}.wav`);
      writeFileSync(wav, plain, { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        const player = spawn("/usr/bin/afplay", [wav], { stdio: "inherit" });
        player.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`afplay exited ${code}`)),
        );
        player.on("error", reject);
      }).finally(() => rmSync(dir, { recursive: true, force: true }));
    } catch (err) {
      fail(err);
    }
  });

recording
  .command("export")
  .description("Decrypt a recording to a WAV file you choose")
  .argument("<recordingSid>")
  .requiredOption("--out <path>", "output .wav path")
  .action(async (recordingSid: string, opts: { out: string }) => {
    try {
      const store = new EncryptedRecordingStore(recordingsDir());
      const plain = await store.load(recordingSid);
      writeFileSync(opts.out, plain, { mode: 0o600 });
      console.log(`exported ${plain.length} bytes → ${opts.out}`);
    } catch (err) {
      fail(err);
    }
  });

recording
  .command("delete")
  .description("Delete a recording locally, at the provider, or both (requires --yes)")
  .argument("<recordingSid>")
  .requiredOption("--scope <scope>", "local | provider | both")
  .option("--yes", "explicit confirmation", false)
  .action(async (recordingSid: string, opts: { scope: string; yes: boolean }) => {
    try {
      if (!opts.yes) fail(new Error("refusing to delete without --yes"));
      const input = parseInput(deleteRecording.input, {
        recordingSid,
        scope: opts.scope,
        confirm: true,
      });
      const cfg = loadConfig();
      printJson(await admin(cfg).deleteRecording(input.recordingSid, input.scope, input.confirm));
    } catch (err) {
      fail(err);
    }
  });

// D-40/D-47: legacy voice-mcp → telephony-mcp state migration. Startup-only,
// before any command touches the DB; skips (with a warning) when another
// process still holds the legacy DB, and paths.ts then falls back to reading
// the legacy locations so nothing silently disappears.
migrateLegacyState();

program.parseAsync(process.argv).catch(fail);
