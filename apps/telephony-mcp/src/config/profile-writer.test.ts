/**
 * The config write path, against temp files only — never the live config.
 */
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planVoiceProfile, writeVoiceProfile } from "./profile-writer.js";
import { ConfigError, parseConfig } from "./schema.js";

const BASE_CONFIG = {
  telephony: { fromNumber: "+61255501234" },
  llm: { type: "openai-compatible", model: "m" },
  voice: { voiceId: "hostVoice", stability: 0.7, similarity: 0.8 },
  recipients: { george: { number: "+61400111222", recordingPolicy: "preconsented" } },
  profiles: {
    default: {
      systemPrompt: "You are calling on behalf of George.",
      greeting: "Hi, this is George's assistant.",
      voice: { language: "en-AU", stability: 0.7 },
    },
    brisk: { systemPrompt: "Be brief." },
  },
};

const WRITE = {
  name: "harbour",
  base: "default",
  voice: { voiceId: "M7ya1YbaeFaPXljg9BpK", speed: 0.95, stability: 0.5, similarity: 0.8 },
  overwrite: false,
};

function tempConfig(content: unknown = BASE_CONFIG, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "tel-profile-writer-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 4));
  chmodSync(path, mode);
  return path;
}

describe("planVoiceProfile (pure)", () => {
  it("copies the base profile and overrides only its voice", () => {
    const plan = planVoiceProfile(JSON.stringify(BASE_CONFIG), WRITE);
    expect(plan.replaces).toBe(false);
    expect(plan.profile).toEqual({
      systemPrompt: "You are calling on behalf of George.",
      greeting: "Hi, this is George's assistant.",
      voice: {
        language: "en-AU",
        voiceId: "M7ya1YbaeFaPXljg9BpK",
        speed: 0.95,
        stability: 0.5,
        similarity: 0.8,
      },
    });
    const next = parseConfig(JSON.parse(plan.nextText));
    expect(Object.keys(next.profiles).sort()).toEqual(["brisk", "default", "harbour"]);
  });

  it("a null setting removes the base's value (the platform default applies)", () => {
    const plan = planVoiceProfile(JSON.stringify(BASE_CONFIG), {
      ...WRITE,
      voice: { ...WRITE.voice, stability: null, similarity: null },
    });
    expect(plan.profile.voice).not.toHaveProperty("stability");
    expect(plan.profile.voice).not.toHaveProperty("similarity");
  });

  it("refuses to replace an existing profile unless overwrite", () => {
    expect(() =>
      planVoiceProfile(JSON.stringify(BASE_CONFIG), { ...WRITE, name: "brisk" }),
    ).toThrow(/already exists/);
    const plan = planVoiceProfile(JSON.stringify(BASE_CONFIG), {
      ...WRITE,
      name: "brisk",
      overwrite: true,
    });
    expect(plan.replaces).toBe(true);
  });

  it("refuses an unknown base, broken JSON, and a result the schema rejects", () => {
    expect(() => planVoiceProfile(JSON.stringify(BASE_CONFIG), { ...WRITE, base: "nope" })).toThrow(
      ConfigError,
    );
    expect(() => planVoiceProfile("{oops", WRITE)).toThrow(/not valid JSON/);
    expect(() =>
      planVoiceProfile(JSON.stringify(BASE_CONFIG), { ...WRITE, name: "Not A Key" }),
    ).toThrow(ConfigError);
    expect(() =>
      planVoiceProfile(JSON.stringify(BASE_CONFIG), {
        ...WRITE,
        voice: { ...WRITE.voice, speed: 9 },
      }),
    ).toThrow(/speed/);
  });

  it("leaves every other key exactly as it was", () => {
    const next = JSON.parse(planVoiceProfile(JSON.stringify(BASE_CONFIG), WRITE).nextText);
    const { profiles: _p, ...rest } = next;
    const { profiles: _q, ...before } = BASE_CONFIG;
    expect(rest).toEqual(before);
    expect(next.profiles.default).toEqual(BASE_CONFIG.profiles.default);
  });
});

describe("writeVoiceProfile (temp file)", () => {
  it("writes atomically, keeps the file mode, and leaves a byte-identical backup", () => {
    const path = tempConfig(BASE_CONFIG, 0o600);
    const before = readFileSync(path, "utf8");
    const result = writeVoiceProfile(path, WRITE, Date.UTC(2026, 8, 23, 10, 0, 0));
    expect(result.backupPath).toMatch(/config\.json\.bak-2026-09-23T10-00-00-000Z$/);
    expect(readFileSync(result.backupPath, "utf8")).toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const written = parseConfig(JSON.parse(readFileSync(path, "utf8")));
    expect(written.profiles.harbour?.voice?.voiceId).toBe("M7ya1YbaeFaPXljg9BpK");
    // No temp file left behind.
    const dir = join(path, "..");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("writes nothing (and makes no backup) when the plan is refused", () => {
    const path = tempConfig();
    const before = readFileSync(path, "utf8");
    expect(() => writeVoiceProfile(path, { ...WRITE, name: "default" })).toThrow(/already exists/);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(join(path, "..")).filter((f) => f.includes(".bak-"))).toEqual([]);
  });
});
