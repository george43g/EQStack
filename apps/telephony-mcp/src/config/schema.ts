/**
 * External configuration — strictly validated at the boundary (repo rule:
 * parse, don't guess). The config file is the ONLY place a full phone number
 * or a secret *reference* may appear; secret VALUES never appear anywhere
 * (they resolve at runtime via SecretProvider by variable name).
 *
 * Default location: ~/.config/voice-mcp/config.json
 * (override: VOICE_MCP_CONFIG=/path/to/config.json)
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +61400000000");

export const RecordingPolicySchema = z.enum(["preconsented", "manual", "never"]);
export type RecordingPolicy = z.infer<typeof RecordingPolicySchema>;

export const RecipientSchema = z
  .object({
    number: E164,
    displayName: z.string().min(1).optional(),
    recordingPolicy: RecordingPolicySchema,
  })
  .strict();
export type Recipient = z.infer<typeof RecipientSchema>;

/** TTS/STT settings rendered into ConversationRelay TwiML. */
export const VoiceSchema = z
  .object({
    ttsProvider: z.literal("ElevenLabs").default("ElevenLabs"),
    voiceId: z.string().min(1),
    /** ElevenLabs model suffix used in the ConversationRelay voice string. */
    model: z.string().default("flash_v2_5"),
    speed: z.number().min(0.5).max(2).default(1),
    stability: z.number().min(0).max(1).optional(),
    similarity: z.number().min(0).max(1).optional(),
    language: z.string().default("en-AU"),
    transcription: z
      .object({
        provider: z.enum(["Deepgram", "Google"]).default("Deepgram"),
        /** Deepgram Flux is the default; Google STT stays a configurable alternative. */
        model: z.string().default("flux"),
      })
      .strict()
      .default({}),
  })
  .strict();
export type VoiceConfig = z.infer<typeof VoiceSchema>;

export const ProfileSchema = z
  .object({
    systemPrompt: z.string().min(1),
    /** Overrides llm.model / llm.fallbackModel for calls using this profile. */
    model: z.string().optional(),
    fallbackModel: z.string().optional(),
    maxDurationMinutes: z.number().int().positive().optional(),
    /** Recording default for preconsented recipients (request may still disable). */
    record: z.boolean().optional(),
    /** Spoken by TTS as soon as the callee answers (optional). */
    greeting: z.string().optional(),
    voice: VoiceSchema.partial().optional(),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

export const LlmSchema = z
  .object({
    type: z.literal("openai-compatible"),
    baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
    model: z.string().min(1),
    fallbackModel: z.string().optional(),
    /** Secret NAME resolved via SecretProvider; null for keyless local (Ollama). */
    apiKeyRef: z.string().nullable().default("OPENROUTER_API_KEY"),
    headers: z.record(z.string()).default({}),
    timeoutMs: z.number().int().positive().default(30_000),
    temperature: z.number().min(0).max(2).default(0.7),
    maxTokens: z.number().int().positive().default(1024),
  })
  .strict();
export type LlmConfig = z.infer<typeof LlmSchema>;

/**
 * `elevenlabs-managed` and `twilio-media-streams` are RESERVED adapter ids:
 * the schema accepts them so configs can be staged, but the adapter registry
 * refuses to construct them in v1.
 */
export const TelephonySchema = z
  .object({
    type: z
      .enum(["twilio-conversation-relay", "elevenlabs-managed", "twilio-media-streams"])
      .default("twilio-conversation-relay"),
    fromNumber: E164,
    accountSidRef: z.string().default("TWILIO_ACCOUNT_SID"),
    apiKeyRef: z.string().default("TWILIO_API_KEY"),
    apiSecretRef: z.string().default("TWILIO_API_SECRET"),
    /** Auth token signs webhooks (X-Twilio-Signature); distinct from the API key pair. */
    authTokenRef: z.string().default("TWILIO_AUTH_TOKEN"),
  })
  .strict();
export type TelephonyConfig = z.infer<typeof TelephonySchema>;

export const ServerSchema = z
  .object({
    /** Public HTTPS base (tunnel) — REQUIRED by `voice-mcp serve` at startup. */
    publicBaseUrl: z.string().url().startsWith("https://").optional(),
    publicPort: z.number().int().min(1).max(65535).default(8790),
    /** Admin/observability listener binds 127.0.0.1 only — never public. */
    adminPort: z.number().int().min(1).max(65535).default(8791),
  })
  .strict()
  .default({});
export type ServerConfig = z.infer<typeof ServerSchema>;

export const LimitsSchema = z
  .object({
    maxConcurrentCalls: z.number().int().min(1).default(1),
    defaultMaxDurationMinutes: z.number().int().min(1).default(15),
    /** Administrator cap — profiles/requests are clamped to this. */
    hardMaxDurationMinutes: z.number().int().min(1).default(30),
    /** How long a prepared call request stays startable. */
    callRequestTtlMinutes: z.number().int().min(1).default(10),
  })
  .strict()
  .default({});
export type Limits = z.infer<typeof LimitsSchema>;

export const ConfigSchema = z
  .object({
    server: ServerSchema,
    telephony: TelephonySchema,
    llm: LlmSchema,
    voice: VoiceSchema,
    recipients: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), RecipientSchema),
    profiles: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), ProfileSchema),
    limits: LimitsSchema,
    disclosure: z
      .object({
        text: z
          .string()
          .min(1)
          .default(
            "Just so you know, I'm an AI assistant and this call may be recorded from this point.",
          ),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.profiles.default) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profiles"],
        message: 'a "default" profile is required',
      });
    }
    for (const [name, p] of Object.entries(cfg.profiles)) {
      if (
        p.maxDurationMinutes !== undefined &&
        p.maxDurationMinutes > cfg.limits.hardMaxDurationMinutes
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", name, "maxDurationMinutes"],
          message: `exceeds limits.hardMaxDurationMinutes (${cfg.limits.hardMaxDurationMinutes})`,
        });
      }
    }
  });
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`invalid config: ${detail}`);
  }
  return result.data;
}

export function loadConfigFile(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config at ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(json);
}

type VoiceOverride = { [K in keyof VoiceConfig]?: VoiceConfig[K] | undefined };

/** Overlay only the keys a profile actually sets (undefined never overwrites). */
function mergeVoice(base: VoiceConfig, override: VoiceOverride | undefined): VoiceConfig {
  if (!override) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) out[k] = v;
  }
  return out as VoiceConfig;
}

/** Effective per-call settings after profile overrides + admin clamps. */
export function effectiveCallSettings(cfg: Config, profileName: string) {
  const profile = cfg.profiles[profileName];
  if (!profile) throw new ConfigError(`unknown profile: ${profileName}`);
  const maxDurationMinutes = Math.min(
    profile.maxDurationMinutes ?? cfg.limits.defaultMaxDurationMinutes,
    cfg.limits.hardMaxDurationMinutes,
  );
  return {
    profile,
    model: profile.model ?? cfg.llm.model,
    fallbackModel: profile.fallbackModel ?? cfg.llm.fallbackModel,
    voice: mergeVoice(cfg.voice, profile.voice),
    maxDurationSec: maxDurationMinutes * 60,
  };
}
