/**
 * Gateway assembly — what `voice-mcp serve` runs: build adapters from
 * config + secrets, open the single-writer store, then start the public
 * listener (Twilio only) and the localhost admin listener.
 */

import { OpenAiCompatibleLlm } from "../adapters/llm/openai-compatible.js";
import { buildTelephonyAdapter } from "../adapters/telephony/registry.js";
import type { Config } from "../config/schema.js";
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

  const publicServer = new PublicServer({ cfg, service, llm, twilioAuthToken, metrics, clock });
  const adminServer = new AdminServer(service, metrics);
  await publicServer.listen(cfg.server.publicPort);
  await adminServer.listen(cfg.server.adminPort);
  logger.info("gateway up", {
    publicPort: cfg.server.publicPort,
    adminPort: cfg.server.adminPort,
    telephony: telephony.id,
    llm: llm.id,
  });

  return {
    service,
    metrics,
    close: async () => {
      service.shutdown();
      await publicServer.close();
      await adminServer.close();
      store.close();
    },
  };
}
