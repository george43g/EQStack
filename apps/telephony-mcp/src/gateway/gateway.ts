/**
 * Gateway assembly — what `tel serve` runs: build adapters from
 * config + secrets, open the single-writer store, then start the public
 * listener (Twilio only) and the localhost admin listener.
 */

import { OpenAiCompatibleLlm } from "../adapters/llm/openai-compatible.js";
import { buildTelephonyAdapter } from "../adapters/telephony/registry.js";
import type { Config } from "../config/schema.js";
import { TunnelSupervisor } from "../daemon/supervisor.js";
import type { Clock, LlmAdapter, SecretProvider } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import { logger } from "../log.js";
import { dbPath, ensureStateDir, recordingsDir } from "../paths.js";
import { EncryptedRecordingStore } from "../stores/recording-store.js";
import { EnvKeychainSecretProvider } from "../stores/secrets.js";
import { SqliteStore } from "../stores/sqlite-store.js";
import { AdminServer } from "./admin-server.js";
import { CallService } from "./call-service.js";
import { Metrics } from "./metrics.js";
import { PublicServer } from "./public-server.js";

export async function buildLlmAdapter(
  cfg: Config,
  secrets: SecretProvider,
  fetchImpl?: typeof fetch,
): Promise<LlmAdapter> {
  const apiKey = cfg.llm.apiKeyRef ? await secrets.get(cfg.llm.apiKeyRef) : null;
  if (cfg.llm.apiKeyRef && !apiKey) {
    throw new Error(`missing LLM API key: ${cfg.llm.apiKeyRef} (env or opkeep keychain cache)`);
  }
  return new OpenAiCompatibleLlm({
    baseUrl: cfg.llm.baseUrl,
    apiKey,
    headers: cfg.llm.headers,
    timeoutMs: cfg.llm.timeoutMs,
    temperature: cfg.llm.temperature,
    maxTokens: cfg.llm.maxTokens,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export interface Gateway {
  service: CallService;
  metrics: Metrics;
  /** Present when tunnel.enabled — serve parents cloudflared (D-c). */
  tunnel: TunnelSupervisor | null;
  close(): Promise<void>;
}

export async function startGateway(
  cfg: Config,
  opts: {
    secrets?: SecretProvider;
    clock?: Clock;
    fetchImpl?: typeof fetch;
    /** Test seams — production always builds from config + secrets. */
    telephony?: import("../domain/ports.js").TelephonyAdapter;
    llm?: LlmAdapter;
    recordings?: import("../domain/ports.js").RecordingStore;
  } = {},
): Promise<Gateway> {
  if (!cfg.server.publicBaseUrl) {
    throw new Error(
      "server.publicBaseUrl is required — start the tunnel first and set it in config",
    );
  }
  const secrets = opts.secrets ?? new EnvKeychainSecretProvider();
  const clock = opts.clock ?? systemClock;
  ensureStateDir();

  const twilioAuthToken = await secrets.get(cfg.telephony.authTokenRef);
  if (!twilioAuthToken) {
    throw new Error(
      `missing ${cfg.telephony.authTokenRef} — webhook signatures cannot be validated`,
    );
  }
  const telephony =
    opts.telephony ??
    (await buildTelephonyAdapter(cfg.telephony, secrets, opts.fetchImpl ?? fetch));
  const llm = opts.llm ?? (await buildLlmAdapter(cfg, secrets, opts.fetchImpl));

  const store = new SqliteStore(dbPath());
  const recordings = opts.recordings ?? new EncryptedRecordingStore(recordingsDir());
  const metrics = new Metrics();
  const service = new CallService(cfg, store, telephony, recordings, clock, undefined, metrics);

  // D-d: the tunnel starts degraded-tolerant — a tunnel that never becomes
  // ready leaves the gateway up and reporting, it does not abort serve.
  let tunnel: TunnelSupervisor | null = null;
  if (cfg.tunnel.enabled) {
    const { spawn } = await import("node:child_process");
    tunnel = new TunnelSupervisor(cfg.tunnel, {
      spawn: (bin, args, opts) => {
        const child = spawn(bin, args, { env: { ...process.env, ...opts.env }, stdio: "ignore" });
        return {
          pid: child.pid,
          kill: (signal?: NodeJS.Signals) => child.kill(signal),
          once: (event: "exit", listener: (code: number | null, signal: string | null) => void) =>
            void child.once(event, listener),
        };
      },
      fetchImpl: opts.fetchImpl ?? fetch,
      clock,
      secrets,
      stateDir: ensureStateDir(),
    });
    void tunnel.start();
  }

  const publicServer = new PublicServer({ cfg, service, llm, twilioAuthToken, metrics, clock });
  const adminServer = new AdminServer(service, metrics);
  await publicServer.listen(cfg.server.publicPort);
  await adminServer.listen(cfg.server.adminPort);
  logger.info("gateway up", {
    publicPort: cfg.server.publicPort,
    adminPort: cfg.server.adminPort,
    telephony: telephony.id,
    llm: llm.id,
    tunnel: tunnel ? "supervised" : "external",
  });

  return {
    service,
    metrics,
    tunnel,
    close: async () => {
      await tunnel?.stop();
      service.shutdown();
      await publicServer.close();
      await adminServer.close();
      store.close();
    },
  };
}
