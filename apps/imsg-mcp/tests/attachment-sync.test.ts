/**
 * Stage 7 — attachment sync nudge orchestrator. Every side effect (AppleScript,
 * fs, timers) is injected, so the tier/poll/timeout logic runs deterministically
 * with a fake clock — no real app launch, no real waiting. The file "appears" on
 * disk when the fake clock reaches `appearAtMs`, which lets us model T1-only,
 * T2-after-T1, and timeout paths precisely.
 */
import { describe, expect, it } from "vitest";
import {
  buildImessageOpenUrl,
  openConversationInMessages,
  syncNowViaSystemEvents,
} from "../src/applescript.js";
import {
  type AttachmentSyncConfig,
  type AttachmentSyncDeps,
  defaultAttachmentSyncDeps,
  ensureAttachmentDownloaded,
  type SyncNowOutcome,
} from "../src/attachment-sync.js";

interface FakeOpts {
  /** File is on disk once the fake clock reaches this (ms). Infinity = never. */
  appearAtMs?: number;
  openConversation?: () => Promise<void>;
  syncNow?: () => Promise<SyncNowOutcome>;
}

function makeDeps(opts: FakeOpts = {}) {
  let clock = 0;
  const calls = { open: 0, sync: 0, sleeps: 0 };
  const appearAt = opts.appearAtMs ?? Number.POSITIVE_INFINITY;
  const deps: AttachmentSyncDeps = {
    fileExists: () => clock >= appearAt,
    openConversation: async () => {
      calls.open++;
      await opts.openConversation?.();
    },
    syncNow: async () => {
      calls.sync++;
      return (await opts.syncNow?.()) ?? { ok: true };
    },
    sleep: async (ms) => {
      calls.sleeps++;
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls };
}

const CFG = (over: Partial<AttachmentSyncConfig> = {}): AttachmentSyncConfig => ({
  enabled: true,
  tier2SyncNow: false,
  timeoutSeconds: 5,
  pollIntervalMs: 1000,
  ...over,
});

describe("ensureAttachmentDownloaded", () => {
  it("short-circuits when the file is already on disk (no side effects)", async () => {
    const { deps, calls } = makeDeps({ appearAtMs: 0 });
    const res = await ensureAttachmentDownloaded({ filePath: "/x", chatId: "+1555" }, CFG(), deps);
    expect(res).toMatchObject({ downloaded: true, attempted: false, tier: 0 });
    expect(calls.open).toBe(0);
    expect(calls.sync).toBe(0);
  });

  it("does nothing when nudging is disabled", async () => {
    const { deps, calls } = makeDeps({ appearAtMs: 1000 });
    const res = await ensureAttachmentDownloaded(
      { filePath: "/x", chatId: "+1555" },
      CFG({ enabled: false }),
      deps,
    );
    expect(res).toMatchObject({ downloaded: false, attempted: false, tier: 0 });
    expect(res.reason).toMatch(/disabled/);
    expect(calls.open).toBe(0);
  });

  it("Tier 1: opens the conversation and resolves true when the file appears", async () => {
    const { deps, calls } = makeDeps({ appearAtMs: 3000 });
    const res = await ensureAttachmentDownloaded({ filePath: "/x", chatId: "+1555" }, CFG(), deps);
    expect(res).toMatchObject({ downloaded: true, attempted: true, tier: 1 });
    expect(calls.open).toBe(1);
    expect(calls.sync).toBe(0);
  });

  it("Tier 1: times out to false when the file never appears", async () => {
    const { deps, calls } = makeDeps({ appearAtMs: Number.POSITIVE_INFINITY });
    const res = await ensureAttachmentDownloaded({ filePath: "/x", chatId: "+1555" }, CFG(), deps);
    expect(res).toMatchObject({ downloaded: false, attempted: true, tier: 1 });
    expect(res.reason).toMatch(/did not download/);
    expect(calls.open).toBe(1);
  });

  it("no chatId + Tier 2 off: no tier runs, hints about the missing identifier", async () => {
    const { deps, calls } = makeDeps({ appearAtMs: Number.POSITIVE_INFINITY });
    const res = await ensureAttachmentDownloaded({ filePath: "/x", chatId: null }, CFG(), deps);
    expect(res).toMatchObject({ downloaded: false, attempted: false, tier: 0 });
    expect(res.hint).toMatch(/chat identifier/i);
    expect(calls.open).toBe(0);
    expect(calls.sync).toBe(0);
  });

  it("Tier 2: falls through to Sync Now and resolves true when the file appears", async () => {
    // Appears at 6s — after the 5s T1 poll gives up, only the T2 poll can see it.
    const { deps, calls } = makeDeps({ appearAtMs: 6000 });
    const res = await ensureAttachmentDownloaded(
      { filePath: "/x", chatId: "+1555" },
      CFG({ tier2SyncNow: true }),
      deps,
    );
    expect(res).toMatchObject({ downloaded: true, attempted: true, tier: 2 });
    expect(calls.open).toBe(1);
    expect(calls.sync).toBe(1);
  });

  it("Tier 2: surfaces an Accessibility-permission hint when Sync Now is blocked", async () => {
    const { deps } = makeDeps({
      appearAtMs: Number.POSITIVE_INFINITY,
      syncNow: async () => ({ ok: false, needsAccessibility: true }),
    });
    const res = await ensureAttachmentDownloaded(
      { filePath: "/x", chatId: "+1555" },
      CFG({ tier2SyncNow: true }),
      deps,
    );
    expect(res).toMatchObject({ downloaded: false, tier: 2 });
    expect(res.reason).toBe("accessibility-permission-required");
    expect(res.hint).toMatch(/Accessibility/);
  });
});

describe("buildImessageOpenUrl", () => {
  it("passes a bare handle through", () => {
    expect(buildImessageOpenUrl("+15551234567")).toBe("imessage://+15551234567");
    expect(buildImessageOpenUrl("name@icloud.com")).toBe("imessage://name@icloud.com");
  });

  it("extracts the handle from a 1:1 chat GUID and trims whitespace", () => {
    expect(buildImessageOpenUrl("iMessage;-;+15551234567")).toBe("imessage://+15551234567");
    expect(buildImessageOpenUrl("  +15551234567  ")).toBe("imessage://+15551234567");
  });
});

describe("defaultAttachmentSyncDeps (AppleScript mocked under Vitest)", () => {
  it("wires the 5 side effects; openConversation/syncNow are no-ops under mock", async () => {
    const deps = defaultAttachmentSyncDeps();
    expect(typeof deps.fileExists).toBe("function");
    await expect(openConversationInMessages("+1555")).resolves.toBeUndefined();
    await expect(syncNowViaSystemEvents()).resolves.toEqual({ ok: true });
  });
});
