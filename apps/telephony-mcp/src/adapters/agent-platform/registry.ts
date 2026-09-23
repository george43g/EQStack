/**
 * Agent-platform registry (Phase Q, D-75). One registered id today,
 * `elevenlabs-managed` — the name Phase B reserved as a telephony adapter,
 * kept for the new port so anything written against the reservation still
 * resolves to the same thing.
 *
 * Construction resolves no secret: the adapter resolves ELEVENLABS_API_KEY by
 * name per request (INV-12), so a missing key fails the delegate call that
 * needed it — naming the variable — instead of taking down `serve` and with
 * it every direct and byo-model call.
 */
import type { AgentPlatformConfig } from "../../config/schema.js";
import type { AgentPlatformPort, SecretProvider, VoicePreviewPort } from "../../domain/ports.js";
import { ElevenLabsAgentPlatform } from "./elevenlabs.js";
import { ElevenLabsVoicePreview } from "./elevenlabs-preview.js";

export function buildAgentPlatform(
  cfg: AgentPlatformConfig,
  secrets: SecretProvider,
  fetchImpl: typeof fetch = fetch,
): AgentPlatformPort {
  switch (cfg.type) {
    case "elevenlabs-managed":
      return new ElevenLabsAgentPlatform({
        apiKeyRef: cfg.apiKeyRef,
        secrets,
        fetchImpl,
        baseUrl: cfg.baseUrl,
      });
  }
}

/** The voice-preview client for the same platform block (same key, same base URL). */
export function buildVoicePreview(
  cfg: AgentPlatformConfig,
  secrets: SecretProvider,
  fetchImpl: typeof fetch = fetch,
): VoicePreviewPort {
  switch (cfg.type) {
    case "elevenlabs-managed":
      return new ElevenLabsVoicePreview({
        apiKeyRef: cfg.apiKeyRef,
        secrets,
        fetchImpl,
        baseUrl: cfg.baseUrl,
      });
  }
}
