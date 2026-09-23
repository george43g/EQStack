/**
 * The preview workflow over a fake port and a TEMP config file (INV-14: no
 * network; and never George's live config).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDispatcher } from "@george43g/mcp-kit";
import { describe, expect, it } from "vitest";
import { buildClientRegistry } from "../commands/bind-client.js";
import { parseConfig } from "../config/schema.js";
import type { AgentConversationStatus, VoicePreviewPort } from "../domain/ports.js";
import {
  ADJUST_TOOL,
  PREVIEW_AGENT_NAME,
  type PreviewAgentSpec,
  type PreviewToolCall,
  SAVE_TOOL,
} from "../domain/voice-preview.js";
import { VoicePreviewError, VoicePreviewService } from "./service.js";

interface FakeSession {
  id: string;
  status: AgentConversationStatus;
  startedAtSecs: number;
  toolCalls: PreviewToolCall[];
}

class FakePort implements VoicePreviewPort {
  agent: { agentId: string; spec: PreviewAgentSpec } | null = null;
  sessions: FakeSession[] = [];
  writes: string[] = [];

  async findPreviewAgent(name: string) {
    if (!this.agent || name !== PREVIEW_AGENT_NAME) return null;
    return {
      agentId: this.agent.agentId,
      voices: this.agent.spec.voices.map((v) => ({
        label: v.label,
        voiceId: v.voiceId,
        speed: v.speed,
        stability: v.stability,
        similarityBoost: v.similarityBoost,
      })),
    };
  }
  async createPreviewAgent(spec: PreviewAgentSpec) {
    this.writes.push("create");
    this.agent = { agentId: "agent_fake", spec };
    return { agentId: "agent_fake" };
  }
  async updatePreviewAgent(agentId: string, spec: PreviewAgentSpec) {
    this.writes.push(`update ${agentId}`);
    this.agent = { agentId, spec };
  }
  talkUrl(agentId: string) {
    return `https://talk.test/?agent_id=${agentId}`;
  }
  async listPreviewConversations(_agentId: string, limit: number) {
    return [...this.sessions]
      .sort((a, b) => b.startedAtSecs - a.startedAtSecs)
      .slice(0, limit)
      .map((s) => ({ conversationId: s.id, status: s.status, startedAtSecs: s.startedAtSecs }));
  }
  async getPreviewConversation(id: string) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown ${id}`);
    return {
      conversationId: s.id,
      status: s.status,
      toolCalls: s.status === "done" ? s.toolCalls : [],
    };
  }
}

const call = (name: string, params: unknown): PreviewToolCall => ({
  name,
  paramsJson: JSON.stringify(params),
});

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "tel-voice-preview-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      telephony: { fromNumber: "+61255501234" },
      llm: { type: "openai-compatible", model: "m" },
      voice: { voiceId: "hostVoice" },
      profiles: { default: { systemPrompt: "You call for George.", greeting: "Hi." } },
    }),
  );
  return path;
}

function setup() {
  const port = new FakePort();
  const configPath = tempConfig();
  const service = new VoicePreviewService({ port, configPath, nowMs: () => 1_790_000_000_000 });
  return { port, configPath, service };
}

const readProfiles = (path: string) => parseConfig(JSON.parse(readFileSync(path, "utf8"))).profiles;

describe("preview", () => {
  it("creates the agent once, then updates it in place (idempotent)", async () => {
    const { port, service } = setup();
    const first = await service.preview({ candidates: 6 });
    expect(first).toMatchObject({ action: "create", agentName: PREVIEW_AGENT_NAME });
    expect(first.talkUrl).toBe("https://talk.test/?agent_id=agent_fake");
    expect(first.voices).toHaveLength(6);
    const second = await service.preview({ candidates: 6 });
    expect(second.action).toBe("update");
    expect(port.writes).toEqual(["create", "update agent_fake"]);
    expect(second.voices).toEqual(first.voices);
  });

  it("applyFrom folds a finished session's adjustments in, and a later plain run keeps them", async () => {
    const { port, service } = setup();
    await service.preview();
    port.sessions.push({
      id: "conv_a",
      status: "done",
      startedAtSecs: 100,
      toolCalls: [call(ADJUST_TOOL, { label: "Roger", speed: 0.8, note: "slower" })],
    });
    const applied = await service.preview({ applyFrom: "latest" });
    expect(applied.appliedFrom).toBe("conv_a");
    expect(applied.applied).toEqual([{ label: "Roger", speed: 0.8, note: "slower" }]);
    expect(applied.voices.find((v) => v.label === "Roger")?.speed).toBe(0.8);
    const again = await service.preview();
    expect(again.voices.find((v) => v.label === "Roger")?.speed).toBe(0.8);
    const reset = await service.preview({ reset: true });
    expect(reset.voices.find((v) => v.label === "Roger")?.speed).toBe(0.9);
  });

  it("refuses to apply a session that is still running", async () => {
    const { port, service } = setup();
    await service.preview();
    port.sessions.push({ id: "conv_live", status: "in-progress", startedAtSecs: 1, toolCalls: [] });
    await expect(service.preview({ applyFrom: "latest" })).rejects.toThrow(/in-progress/);
  });
});

describe("review and save", () => {
  it("review before any agent exists says what to run", async () => {
    const { service } = setup();
    await expect(service.review()).rejects.toBeInstanceOf(VoicePreviewError);
  });

  it("saves the voice George named in the session into the temp config", async () => {
    const { port, service, configPath } = setup();
    await service.preview();
    port.sessions.push({
      id: "conv_b",
      status: "done",
      startedAtSecs: 200,
      toolCalls: [call(SAVE_TOOL, { label: "Hannah", name: "Harbour" })],
    });
    const review = await service.review();
    expect(review.saves.map((s) => s.profileName)).toEqual(["harbour"]);

    const dry = await service.save({ dryRun: true });
    expect(dry.saved[0]).toMatchObject({ name: "harbour", label: "Hannah", backupPath: null });
    expect(readProfiles(configPath)).not.toHaveProperty("harbour");

    const result = await service.save({});
    expect(result.saved[0]).toMatchObject({
      name: "harbour",
      label: "Hannah",
      base: "default",
      replaced: false,
      voice: { voiceId: "M7ya1YbaeFaPXljg9BpK", speed: 1, stability: 0.5, similarity: 0.8 },
    });
    const profiles = readProfiles(configPath);
    expect(profiles.harbour).toMatchObject({
      systemPrompt: "You call for George.",
      voice: { voiceId: "M7ya1YbaeFaPXljg9BpK", speed: 1, stability: 0.5, similarity: 0.8 },
    });
    expect(result.notices.join(" ")).toMatch(/restart/);
    // Saving the same session again refuses rather than clobbering.
    await expect(service.save({})).rejects.toThrow(/already exists/);
  });

  it("explicit label + name saves the agent's current settings for that candidate", async () => {
    const { service, configPath } = setup();
    await service.preview();
    const r = await service.save({ label: "ollie", name: "Night Shift" });
    expect(r.saved[0]).toMatchObject({ name: "night-shift", label: "Ollie" });
    expect(readProfiles(configPath)["night-shift"]?.voice?.speed).toBe(0.95);
    await expect(service.save({ label: "Nobody", name: "x" })).rejects.toThrow(/no candidate/);
    await expect(service.save({ label: "Ollie" })).rejects.toThrow(/needs a name/);
  });

  it("a session that named nothing saves nothing and says so", async () => {
    const { port, service } = setup();
    await service.preview();
    port.sessions.push({ id: "conv_c", status: "done", startedAtSecs: 1, toolCalls: [] });
    const r = await service.save({});
    expect(r.saved).toEqual([]);
    expect(r.notices[0]).toContain("named no voice");
  });
});

describe("watchStep", () => {
  it("handles each finished session once, oldest first, applying then saving", async () => {
    const { port, service, configPath } = setup();
    await service.preview();
    port.sessions.push(
      {
        id: "conv_1",
        status: "done",
        startedAtSecs: 1_000,
        toolCalls: [call(ADJUST_TOOL, { label: "Lily", speed: 0.9 })],
      },
      {
        id: "conv_2",
        status: "done",
        startedAtSecs: 1_100,
        toolCalls: [call(SAVE_TOOL, { label: "Lily", name: "Velvet" })],
      },
      { id: "conv_live", status: "in-progress", startedAtSecs: 1_200, toolCalls: [] },
      { id: "conv_old", status: "done", startedAtSecs: 10, toolCalls: [] },
    );
    const state = { sinceSecs: 500, seen: new Set<string>(), save: true };
    const rows = await service.watchStep(state);
    expect(rows.map((r) => r.conversationId)).toEqual(["conv_1", "conv_2"]);
    expect(rows[0]?.applied?.voices.find((v) => v.label === "Lily")?.speed).toBe(0.9);
    // The save in the next session picks up the applied change.
    expect(readProfiles(configPath).velvet?.voice?.speed).toBe(0.9);
    expect(await service.watchStep(state)).toEqual([]);
  });

  it("with save off, applies changes but writes no profile", async () => {
    const { port, service, configPath } = setup();
    await service.preview();
    port.sessions.push({
      id: "conv_x",
      status: "done",
      startedAtSecs: 2_000,
      toolCalls: [call(SAVE_TOOL, { label: "Lily", name: "Velvet" })],
    });
    const rows = await service.watchStep({ sinceSecs: 0, seen: new Set(), save: false });
    expect(rows).toEqual([{ conversationId: "conv_x" }]);
    expect(readProfiles(configPath)).not.toHaveProperty("velvet");
  });
});

describe("through the command registry (the MCP/CLI/console path)", () => {
  it("preview_voices and save_voice_profile dispatch to the service, output schema-valid", async () => {
    const { port, service, configPath } = setup();
    const registry = buildClientRegistry({
      admin: {} as never,
      openReadStore: () => null,
      voicePreview: () => service,
    });
    const dispatch = buildDispatcher({ registry, engineLabel: () => "ts" });
    const preview = await dispatch("preview_voices", { candidates: 4 });
    expect(preview.isError).toBeFalsy();
    expect((preview.structuredContent as { voices: unknown[] }).voices).toHaveLength(4);

    port.sessions.push({
      id: "conv_r",
      status: "done",
      startedAtSecs: 3_000,
      toolCalls: [call(SAVE_TOOL, { label: "David", name: "Deep End" })],
    });
    const saved = await dispatch("save_voice_profile", { conversation: "conv_r" });
    expect(saved.isError).toBeFalsy();
    expect(readProfiles(configPath)).toHaveProperty("deep-end");
  });

  it("without an agentPlatform block the preview tools refuse with a pointer", async () => {
    const registry = buildClientRegistry({ admin: {} as never, openReadStore: () => null });
    const dispatch = buildDispatcher({ registry, engineLabel: () => "ts" });
    const r = await dispatch("preview_voices", {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("agentPlatform");
  });
});
