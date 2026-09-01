#!/usr/bin/env node
/**
 * voice-mcp CLI — three entrypoints over the same domain services:
 *   voice-mcp mcp     stdio MCP server (stderr-only logging)
 *   voice-mcp serve   public Twilio listener + localhost admin listener
 *   voice-mcp …       operator commands (doctor, prepare, call, watch,
 *                     recording play|export|delete, history …)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { AdminClient, GatewayUnavailableError } from "./client/admin-client.js";
import { type Config, loadConfigFile } from "./config/schema.js";
import { startGateway } from "./gateway/gateway.js";
import { logger } from "./log.js";
import { buildMcpServer } from "./mcp/server.js";
import { configPath, dbPath, recordingsDir } from "./paths.js";
import { EncryptedRecordingStore } from "./stores/recording-store.js";
import { EnvKeychainSecretProvider } from "./stores/secrets.js";
import { SqliteStore } from "./stores/sqlite-store.js";

function loadConfig(): Config {
  return loadConfigFile(configPath());
}

function admin(cfg: Config): AdminClient {
  return new AdminClient(cfg.server.adminPort);
}

function fail(err: unknown): never {
  console.error(`voice-mcp: ${(err as Error).message}`);
  process.exit(1);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const program = new Command();
program.name("voice-mcp").description("Agent-initiated real-time phone calls (MCP + gateway)");

program
  .command("mcp")
  .description("Run the stdio MCP server")
  .action(async () => {
    try {
      const cfg = loadConfig();
      const server = buildMcpServer({ cfg, admin: admin(cfg) });
      await server.connect(new StdioServerTransport());
      logger.info("mcp server on stdio");
    } catch (err) {
      fail(err);
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
          : "missing — serve will refuse to start (start the tunnel first)",
      );
      push(
        "recipients",
        Object.keys(cfg.recipients).length > 0,
        `${Object.keys(cfg.recipients).length} allowlisted`,
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
  .command("prepare")
  .description("Stage 1: create an expiring call request (nothing is dialed)")
  .argument("<recipient>", "allowlisted recipient alias")
  .requiredOption("--objective <text>", "what the call should achieve")
  .option("--context <text>", "extra context for the LLM")
  .option("--profile <name>", "call profile")
  .option("--record", "request recording (subject to recipient policy)")
  .option("--no-record", "request no recording")
  .option("--mode <mode>", "conversation driver: llm (default) | direct (host replies via say)")
  .action(async (recipient: string, opts) => {
    try {
      if (opts.mode !== undefined && opts.mode !== "llm" && opts.mode !== "direct") {
        fail(new Error("--mode must be llm | direct"));
      }
      const cfg = loadConfig();
      const { request } = await admin(cfg).prepare({
        recipient,
        objective: opts.objective,
        ...(opts.context ? { context: opts.context } : {}),
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(opts.record !== undefined ? { record: opts.record } : {}),
        ...(opts.mode ? { mode: opts.mode as "llm" | "direct" } : {}),
      });
      printJson(request);
      console.error(`\nTo dial: voice-mcp call ${request.id} --yes   (REAL, PAID phone call)`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("call")
  .description("Stage 2: dial a prepared request (REAL, PAID phone call — requires --yes)")
  .argument("<requestId>", "request id from `voice-mcp prepare`")
  .option("--yes", "explicit confirmation to dial", false)
  .action(async (requestId: string, opts: { yes: boolean }) => {
    try {
      if (!opts.yes) {
        fail(new Error("refusing to dial without --yes (this places a real, paid phone call)"));
      }
      const cfg = loadConfig();
      const { call } = await admin(cfg).start(requestId, true);
      printJson(call);
      console.error(`\nWatch live: voice-mcp watch`);
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
    printJson(withReadStore((s) => s.listCalls({ limit: Number(opts.limit) })));
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
      const dir = mkdtempSync(join(tmpdir(), "voice-mcp-play-"));
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
      if (!["local", "provider", "both"].includes(opts.scope)) {
        fail(new Error("--scope must be local | provider | both"));
      }
      const cfg = loadConfig();
      printJson(
        await admin(cfg).deleteRecording(
          recordingSid,
          opts.scope as "local" | "provider" | "both",
          true,
        ),
      );
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv).catch(fail);
