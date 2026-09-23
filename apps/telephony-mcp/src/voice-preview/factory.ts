/**
 * Builds the voice-preview workflow from config, lazily: nothing resolves the
 * platform key until a preview command actually runs (INV-12), and a config
 * without an agentPlatform block yields no factory — the commands then refuse
 * with a pointer instead of the MCP server failing to start.
 */
import { buildVoicePreview } from "../adapters/agent-platform/registry.js";
import type { Config } from "../config/schema.js";
import type { SecretProvider } from "../domain/ports.js";
import { configPath } from "../paths.js";
import { EnvKeychainSecretProvider } from "../stores/secrets.js";
import { VoicePreviewService } from "./service.js";

export function voicePreviewFactory(
  cfg: Config,
  secrets: SecretProvider = new EnvKeychainSecretProvider(),
): (() => VoicePreviewService) | undefined {
  const platform = cfg.agentPlatform;
  if (!platform) return undefined;
  let service: VoicePreviewService | undefined;
  return () => {
    service ??= new VoicePreviewService({
      port: buildVoicePreview(platform, secrets),
      configPath: configPath(),
    });
    return service;
  };
}
