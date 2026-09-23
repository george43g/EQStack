/**
 * External configuration — strictly validated at the boundary (repo rule:
 * parse, don't guess). The config file is the ONLY place a full phone number
 * or a secret *reference* may appear; secret VALUES never appear anywhere
 * (they resolve at runtime via SecretProvider by variable name).
 *
 * Default location: ~/.config/voice-mcp/config.json
 * (override: TEL_CONFIG=/path/to/config.json)
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const E164Schema = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164, e.g. +61400000000");
const E164 = E164Schema;

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
 * `twilio-media-streams` is a RESERVED adapter id: the schema accepts it so
 * configs can be staged, but the adapter registry refuses to construct it.
 * `elevenlabs-managed` stays in the enum only so a config written against the
 * Phase B reservation still parses and then fails with a pointer: D-75 moved
 * it out of telephony into the top-level `agentPlatform` block.
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

/** Registered agent-platform ids. D-75 keeps the Phase B name for the new port. */
export const AGENT_PLATFORM_IDS = ["elevenlabs-managed"] as const;
export type AgentPlatformId = (typeof AGENT_PLATFORM_IDS)[number];

/** Who holds a delegate call's recording, by name, for the D-76 consent text. */
export const AGENT_PLATFORM_HOLDER: Readonly<Record<AgentPlatformId, string>> = {
  "elevenlabs-managed": "ElevenLabs",
};

/**
 * Optional Twilio hang-up for off-device calls (O-30). EL places delegate
 * calls on a Twilio SUBACCOUNT, which the main account's API key cannot reach
 * (Twilio: main-account keys are for main-account resources only), so this
 * names a restricted key minted INSIDE that subaccount — calls read + update,
 * nothing else. The two SIDs are identifiers, not secrets, so they sit here as
 * plain values; the key's secret resolves by NAME (INV-12). Without this
 * block end_call keeps refusing on a delegate call.
 */
export const TwilioHangupSchema = z
  .object({
    /** The subaccount EL dials from (AC…) — not the main `telephony` account. */
    accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/, "must be a Twilio account SID (AC…)"),
    /** The restricted API key's SID (SK…), minted inside that subaccount. */
    apiKeySid: z.string().regex(/^SK[0-9a-fA-F]{32}$/, "must be a Twilio API key SID (SK…)"),
    /** Secret NAME of that key's secret, resolved via SecretProvider — never a value. */
    apiSecretRef: z.string().min(1).default("TWILIO_API_KEY_ELEVENLABS_SUBACCOUNT_CALLS_RW"),
  })
  .strict();
export type TwilioHangupConfig = z.infer<typeof TwilioHangupSchema>;

/**
 * ElevenLabs' published egress addresses, US default region (D-91 layer 3).
 * Source: https://elevenlabs.io/docs/overview/administration/ip-allowlisting —
 * "All outbound requests from ElevenLabs services—including webhooks, WebSocket
 * connections, and MCP server requests—originate from these addresses." Other
 * regions and data-residency workspaces use other lists on the same page; set
 * `agentPlatform.consult.allowedSourceIps` to match the workspace.
 */
export const ELEVENLABS_US_EGRESS_IPS = ["34.67.146.145", "34.59.11.47"] as const;

/**
 * Consult mode (Phase R, D-90..D-94). Opt-in: without this block a `consult`
 * call refuses at plan time and the tool listener never starts.
 */
export const ConsultSchema = z
  .object({
    /**
     * Public HTTPS base of the tool listener, reached through the tunnel's
     * second hostname (D-91). INV-11: a tunnel URL — never logged.
     */
    toolsBaseUrl: z.string().url().startsWith("https://"),
    /** How long `serve` holds a question open before answering `pending` (D-93). */
    holdSec: z.number().int().min(5).max(285).default(45),
    /** More pending questions than this on one call answer `busy`. */
    maxPendingPerCall: z.number().int().min(1).max(20).default(3),
    /** No host long-poll within this many seconds → `unavailable` at once (O-38). */
    hostIdleSec: z.number().int().min(1).max(3600).default(90),
    /**
     * CF-Connecting-IP must be one of these. Empty disables the check (and
     * serve warns at startup) — never the default.
     */
    allowedSourceIps: z.array(z.string().ip()).default([...ELEVENLABS_US_EGRESS_IPS]),
  })
  .strict();
export type ConsultConfig = z.infer<typeof ConsultSchema>;

/** EL's timeout for the consult tool: always past our own hold, so serve answers first (D-93). */
export function consultResponseTimeoutSecs(consult: Pick<ConsultConfig, "holdSec">): number {
  return consult.holdSec + 15;
}

/**
 * The agent platform that holds `delegate` calls (Phase Q, D-75). Optional:
 * without it, delegate calls refuse at plan time and nothing else changes.
 */
export const AgentPlatformSchema = z
  .object({
    type: z.enum(AGENT_PLATFORM_IDS),
    /** Secret NAME resolved via SecretProvider (INV-12) — never a value. */
    apiKeyRef: z.string().min(1).default("ELEVENLABS_API_KEY"),
    /**
     * The platform's id for its own registered number (EL `phnum_…`). Not a
     * phone number, so not INV-11-sensitive by itself — but never log it next
     * to the number it maps to (that pairing is the sensitive thing).
     */
    phoneNumberId: z.string().regex(/^phnum_[A-Za-z0-9]+$/, "must be an ElevenLabs phnum_… id"),
    baseUrl: z.string().url().startsWith("https://").default("https://api.elevenlabs.io"),
    /** How often `serve` polls a live delegate conversation (PHASE-Q open question 4). */
    pollIntervalMs: z.number().int().min(500).max(60_000).default(2_000),
    /** Lets end_call hang a delegate call up through Twilio (O-30). Optional. */
    twilioHangup: TwilioHangupSchema.optional(),
    /** Enables mode `consult` (Phase R). Optional. */
    consult: ConsultSchema.optional(),
  })
  .strict();
export type AgentPlatformConfig = z.infer<typeof AgentPlatformSchema>;

// ── Group calls (PHASE-GC, D-102..D-107) ────────────────────────────────────

/** Session names as ListAgents and the bus print them (`executive`, `eqstack`). */
export const MeetingMemberKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "a session name: lowercase letters, digits, hyphens");

/**
 * EL multi-voice markup is case-sensitive (`<Executive>…</Executive>`, E1),
 * so a label is one capitalised word — nothing the LLM could mis-case or split.
 */
export const MEETING_LABEL_PATTERN = /^[A-Z][A-Za-z]{1,19}$/;

/** EL's cap is 10 voices per agent, including the default (the chair's) — E1. */
export const MAX_MEETING_MEMBERS = 9;

const ProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a profile name");

export const MeetingMemberSchema = z
  .object({
    /** The voice tag: `<Executive>…</Executive>`. */
    label: z
      .string()
      .regex(MEETING_LABEL_PATTERN, "one capitalised word of letters, 2–20 long (e.g. Executive)"),
    /** How the chair names it aloud ("EQ Stack"). */
    displayName: z.string().min(1).max(64),
    /** A saved profile (`profiles.<name>`) — never a raw voice id (D-106). */
    voiceProfile: ProfileNameSchema,
    /** One line; becomes the voice's `description` (when EL should use it, E3). */
    role: z.string().min(1).max(300),
  })
  .strict();
export type MeetingMemberConfig = z.infer<typeof MeetingMemberSchema>;

/**
 * The chair is a SLOT (D-107): EQStack ships the role mechanics only. Name,
 * tone and gate policy come from `personaFile`, a machine-local path that is
 * never committed; without it the chair is a neutral meeting chair.
 */
export const MeetingChairSchema = z
  .object({
    /** The session that occupies the slot (default: the secretary, D-107). */
    agent: MeetingMemberKeySchema.default("secretary"),
    displayName: z.string().min(1).max(64).default("the chair"),
    /** The ensemble agent's default voice — untagged speech is the chair. */
    voiceProfile: ProfileNameSchema,
    /** `~`-relative or absolute path to the chair's phone persona text. Read at brief time. */
    personaFile: z.string().min(1).optional(),
  })
  .strict();

export const MeetingSchema = z
  .object({
    chair: MeetingChairSchema,
    members: z.record(MeetingMemberKeySchema, MeetingMemberSchema),
    /**
     * How long `serve` holds an ask_agent question (D-93's hold, shorter: the
     * whole room waits on it). 60 max keeps holdSec + 15 ≤ 300 (EL's cap).
     */
    holdSec: z.number().int().min(5).max(60).default(20),
    /** Clamped by limits.hardMaxDurationMinutes at dial time. */
    maxDurationMinutes: z.number().int().min(1).default(30),
  })
  .strict();
export type MeetingConfig = z.infer<typeof MeetingSchema>;

/**
 * Third-party consent surface (D-76). Default: disclose and ask. The flag is
 * the caller opting out of being asked — never silent by default, never
 * impossible to silence.
 */
export const ConsentSchema = z
  .object({
    /**
     * Auto-supply the acknowledgement a third-party recording needs (e.g. a
     * delegate call recorded by ElevenLabs) and suppress the notice.
     */
    autoApproveThirdPartyDisclosures: z.boolean().default(false),
  })
  .strict()
  .default({});
export type ConsentConfig = z.infer<typeof ConsentSchema>;

export const ServerSchema = z
  .object({
    /** Public HTTPS base (tunnel) — REQUIRED by `tel serve` at startup. */
    publicBaseUrl: z.string().url().startsWith("https://").optional(),
    publicPort: z.number().int().min(1).max(65535).default(8790),
    /** Admin/observability listener binds 127.0.0.1 only — never public. */
    adminPort: z.number().int().min(1).max(65535).default(8791),
    /**
     * Consult tool listener (Phase R, D-91) — binds 127.0.0.1; only
     * cloudflared reaches it. Starts only with agentPlatform.consult.
     */
    toolsPort: z.number().int().min(1).max(65535).default(8792),
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
    /** @deprecated ignored since Phase C (D-5 dropped the TTL) — accepted so existing configs still parse. */
    callRequestTtlMinutes: z.number().int().min(1).optional(),
    /** One-shot dedupe window: identical place_call retries inside it return the same call (D-5). */
    callDedupeWindowSeconds: z.number().int().min(1).default(120),
  })
  .strict()
  .default({});
export type Limits = z.infer<typeof LimitsSchema>;

/** Named Cloudflare Tunnel supervision (Phase D, D-10/D-36). Opt-in. */
export const TunnelSchema = z
  .object({
    provider: z.enum(["cloudflared"]).default("cloudflared"),
    enabled: z.boolean().default(false),
    /** Tunnel NAME (loggable). The hostname is INV-11-sensitive; never log it. */
    tunnelName: z.string().min(1).optional(),
    hostname: z.string().min(1).optional(),
    /** Second hostname on the same tunnel, for the consult tool listener (D-91). INV-11 as above. */
    toolsHostname: z.string().min(1).optional(),
    /** Secret NAME resolved via env → opkeep (INV-12) — never a value. */
    tokenRef: z.string().nullable().default("CLOUDFLARE_TUNNEL_TOKEN"),
    /** Locally-managed style only; null with the remotely-managed token. */
    credentialsFile: z.string().nullable().default(null),
    binPath: z.string().default("/opt/homebrew/bin/cloudflared"),
    metricsPort: z.number().int().min(1).max(65535).default(20241),
    healthIntervalMs: z.number().int().min(1000).default(15_000),
    restart: z
      .object({
        initialBackoffMs: z.number().int().min(100).default(1_000),
        maxBackoffMs: z.number().int().min(1000).default(60_000),
        giveUpAfter: z.number().int().min(1).default(10),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});
export type TunnelConfig = z.infer<typeof TunnelSchema>;

/** launchd LaunchAgent wrapper (Phase D, D-9/D-37). Linux/systemd parity PARKED. */
export const DaemonSchema = z
  .object({
    label: z.string().default("com.george43g.telephony-mcp"),
    runAtLogin: z.boolean().default(true),
    keepAlive: z.boolean().default(true),
    logDir: z.string().default("~/Library/Logs/telephony-mcp"),
    /** null → resolved from process.execPath at install time (launchd has no PATH). */
    nodeBin: z.string().nullable().default(null),
  })
  .strict()
  .default({});
export type DaemonConfig = z.infer<typeof DaemonSchema>;

export const ConfigSchema = z
  .object({
    server: ServerSchema,
    telephony: TelephonySchema,
    agentPlatform: AgentPlatformSchema.optional(),
    /** Group calls (PHASE-GC). Optional: without it start_meeting refuses at plan time. */
    meeting: MeetingSchema.optional(),
    consent: ConsentSchema,
    llm: LlmSchema,
    voice: VoiceSchema,
    recipients: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), RecipientSchema).default({}),
    profiles: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), ProfileSchema),
    limits: LimitsSchema,
    tunnel: TunnelSchema,
    daemon: DaemonSchema,
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
    if (cfg.tunnel.enabled) {
      // The 403 trap: Twilio signatures are computed against publicBaseUrl.
      // A tunnel hostname that differs routes traffic to a listener that then
      // rejects every webhook and relay upgrade with nothing useful logged.
      if (!cfg.server.publicBaseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tunnel", "enabled"],
          message: "tunnel.enabled requires server.publicBaseUrl to be set",
        });
      } else if (
        cfg.tunnel.hostname &&
        new URL(cfg.server.publicBaseUrl).host !== cfg.tunnel.hostname
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tunnel", "hostname"],
          message: `tunnel.hostname must equal the publicBaseUrl host (${new URL(cfg.server.publicBaseUrl).host}) — a mismatch 403s every Twilio webhook`,
        });
      }
      const consult = cfg.agentPlatform?.consult;
      if (
        cfg.tunnel.toolsHostname &&
        consult &&
        new URL(consult.toolsBaseUrl).host !== cfg.tunnel.toolsHostname
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tunnel", "toolsHostname"],
          message:
            "tunnel.toolsHostname must equal the agentPlatform.consult.toolsBaseUrl host — a mismatch sends every consult question to the wrong place",
        });
      }
      if (!cfg.tunnel.tunnelName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tunnel", "tunnelName"],
          message: "tunnel.enabled requires tunnel.tunnelName",
        });
      }
    }
    // D-59/D-91: the tool channel has its own hostname and trust model; on the
    // Twilio host every consult request would 404 at the public listener.
    const toolsBase = cfg.agentPlatform?.consult?.toolsBaseUrl;
    if (
      toolsBase &&
      cfg.server.publicBaseUrl &&
      new URL(toolsBase).host === new URL(cfg.server.publicBaseUrl).host
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agentPlatform", "consult", "toolsBaseUrl"],
        message:
          "agentPlatform.consult.toolsBaseUrl must use its own hostname, not the publicBaseUrl host (D-91)",
      });
    }
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
    if (cfg.meeting) refineMeeting(cfg, cfg.meeting, ctx);
  });

/**
 * PHASE-GC Step 1: every meeting rule is refused at config load, never at
 * dial time. The voice-id comparison uses the EFFECTIVE voice (profile over
 * base), because that is what the platform would speak.
 */
function refineMeeting(
  cfg: { profiles: Record<string, Profile>; voice: VoiceConfig; agentPlatform?: unknown },
  meeting: MeetingConfig,
  ctx: z.RefinementCtx,
): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["meeting", ...path], message });
  const platform = cfg.agentPlatform as { consult?: unknown } | undefined;
  if (!platform?.consult) {
    issue(
      [],
      'meeting needs the "agentPlatform.consult" block: a meeting is a consult call (D-104)',
    );
  }
  const members = Object.entries(meeting.members);
  if (members.length === 0) issue(["members"], "at least one member is required");
  if (members.length > MAX_MEETING_MEMBERS) {
    issue(
      ["members"],
      `at most ${MAX_MEETING_MEMBERS} members (ElevenLabs allows 10 voices per agent, the chair's included)`,
    );
  }
  const voiceOf = (profile: string): string | null => {
    const p = cfg.profiles[profile];
    return p ? mergeVoice(cfg.voice, p.voice).voiceId : null;
  };
  const seenVoices = new Map<string, string>();
  const claimVoice = (path: (string | number)[], who: string, profile: string) => {
    const id = voiceOf(profile);
    if (id === null) {
      issue([...path, "voiceProfile"], `no such profile "${profile}" (save it first)`);
      return;
    }
    const holder = seenVoices.get(id);
    if (holder) {
      issue(
        [...path, "voiceProfile"],
        `${who} would share a voice with ${holder}: every voice on a meeting must be distinguishable`,
      );
    } else seenVoices.set(id, who);
  };
  claimVoice(["chair"], "the chair", meeting.chair.voiceProfile);
  const seenLabels = new Map<string, string>();
  for (const [key, m] of members) {
    const other = seenLabels.get(m.label);
    if (other) issue(["members", key, "label"], `label "${m.label}" is already used by ${other}`);
    else seenLabels.set(m.label, key);
    claimVoice(["members", key], `member "${key}"`, m.voiceProfile);
  }
}
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

/** A meeting's cap: meeting.maxDurationMinutes, clamped by the administrator's hard cap. */
export function meetingMaxDurationSec(cfg: Config, meeting: MeetingConfig): number {
  return Math.min(meeting.maxDurationMinutes, cfg.limits.hardMaxDurationMinutes) * 60;
}
