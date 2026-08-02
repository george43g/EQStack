import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

function resolveEnvPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (value.startsWith("~/") || value === "~") {
    return join(homedir(), value.slice(2));
  }
  return resolve(process.cwd(), value);
}

export function getEnv(): string {
  return process.env.VITE_ENV ?? "development";
}

/** Bundled DB / mock-sending mode (cloud, CI tests via `.env.test`). */
export function isAiEnv(): boolean {
  return getEnv() === "ai";
}

/** Any non-`ai` mode (e.g. `development` on your Mac). */
export function isLocalEnv(): boolean {
  return !isAiEnv();
}

export function getImsgDbPath(): string {
  return resolveEnvPath(
    process.env.VITE_IMSG_DB_PATH,
    join(homedir(), "Library", "Messages", "chat.db"),
  );
}

export function getContactsDbPaths(): string[] | undefined {
  // Empty string (e.g. an unset config-page field passed through as "") must
  // fall back to the default, not be treated as a literal path — so route
  // through resolveEnvPath rather than `??`.
  const mainResolved = resolveEnvPath(
    process.env.VITE_CONTACTS_DB_PATH,
    join(homedir(), "Library", "Application Support", "AddressBook", "AddressBook-v22.abcddb"),
  );
  const paths = new Set<string>([mainResolved]);

  const sourcesSegment = `${sep}Sources${sep}`;
  const sourcesIndex = mainResolved.indexOf(sourcesSegment);
  const addressBookDir =
    sourcesIndex >= 0 ? mainResolved.slice(0, sourcesIndex) : dirname(mainResolved);

  const addSourceDb = (path: string) => {
    if (existsSync(path)) {
      paths.add(path);
    }
  };

  const uuid = process.env.VITE_ADDRESS_BOOK_UUID;
  if (uuid) {
    addSourceDb(join(addressBookDir, "Sources", uuid, "AddressBook-v22.abcddb"));
  }

  const sourcesDir = join(addressBookDir, "Sources");
  if (existsSync(sourcesDir)) {
    try {
      const entries = readdirSync(sourcesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        addSourceDb(join(sourcesDir, entry.name, "AddressBook-v22.abcddb"));
      }
    } catch {
      // Ignore unreadable Address Book source directories.
    }
  }

  return [...paths];
}

export function getSlugsDbPath(): string {
  return resolveEnvPath(process.env.VITE_SLUGS_DB_PATH, join(homedir(), ".imsg-mcp", "slugs.db"));
}

/** Directory for humans/v1 relationship files (see skills/humans/SKILL.md). */
export function getHumansDirPath(): string {
  return resolveEnvPath(process.env.VITE_HUMANS_DIR, join(homedir(), ".agents", "humans"));
}

export function getVcfPath(): string {
  return resolveEnvPath(process.env.VITE_VCF_PATH, join(process.cwd(), "fixtures", "contacts.vcf"));
}

export interface TranscribeCloudConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 (no trailing slash). */
  baseUrl: string;
  apiKey: string;
  /** Model id sent to the endpoint (default whisper-1). */
  model: string;
}

const TRANSCRIBE_PROVIDER_ALIASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
};

/**
 * Opt-in cloud transcription escape-hatch (OpenAI-compatible
 * `/audio/transcriptions`). Returns null unless BOTH `IMSG_TRANSCRIBE_PROVIDER`
 * and `IMSG_TRANSCRIBE_API_KEY` are set — local on-device transcription
 * (`hear`/`yap`/`whisper-cli`) always takes precedence (see media.ts).
 * `IMSG_TRANSCRIBE_PROVIDER` may be a known alias (`openai`, `groq`) or a raw
 * base URL; `IMSG_TRANSCRIBE_MODEL` overrides the model (default `whisper-1`).
 * Sending audio to a cloud provider means it leaves this device — opt-in only.
 */
export function getTranscribeCloudConfig(): TranscribeCloudConfig | null {
  const provider = process.env.IMSG_TRANSCRIBE_PROVIDER?.trim();
  const apiKey = process.env.IMSG_TRANSCRIBE_API_KEY?.trim();
  if (!provider || !apiKey) return null;
  const resolved = /^https?:\/\//.test(provider)
    ? provider
    : (TRANSCRIBE_PROVIDER_ALIASES[provider.toLowerCase()] ?? provider);
  const baseUrl = resolved.replace(/\/+$/, "");
  const model = process.env.IMSG_TRANSCRIBE_MODEL?.trim() || "whisper-1";
  return { baseUrl, apiKey, model };
}
