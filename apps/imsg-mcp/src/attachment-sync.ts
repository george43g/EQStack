/**
 * Attachment sync nudge (Stage 7) — best-effort, tiered coaxing of Messages.app
 * into downloading an attachment whose bytes aren't on disk yet
 * (`transfer_state === -1`, purged/never-downloaded). iCloud syncs Messages
 * media only while a conversation is OPEN, and there is no public download API
 * (IMTransferAgent is a private SIP'd daemon). So we:
 *
 *   Tier 1 (default): open the conversation in Messages via an `imessage:` URL
 *     — community-verified to make the app pull that thread's media — then poll
 *     `existsSync` until the file appears or a timeout elapses.
 *   Tier 2 (opt-in, `nudge.tier2SyncNow`): UI-script Messages ▸ Settings ▸
 *     iMessage ▸ "Sync Now". Needs Accessibility permission; we detect the
 *     missing-permission error and return an actionable hint.
 *   Tier 3: per-conversation "download all" UI script — documented only
 *     (too fragile across macOS versions), no code here.
 *
 * This module is PURE ORCHESTRATION: every side effect (AppleScript, fs, timers)
 * is injected via {@link AttachmentSyncDeps}, so the tier/poll/timeout logic is
 * unit-tested deterministically with no real app launch and no real clock. The
 * default deps wire the real AppleScript primitives (themselves mocked under
 * Vitest) + node fs/timers.
 */
import { existsSync } from "node:fs";
import {
  openConversationInMessages,
  type SyncNowOutcome,
  syncNowViaSystemEvents,
} from "./applescript.js";

export type { SyncNowOutcome };

/** The subset of the resolved `nudge` config this module needs. */
export interface AttachmentSyncConfig {
  /** Master switch — when false, no tier runs and we never touch Messages. */
  enabled: boolean;
  /** Enable Tier 2 (System Events "Sync Now"). Default off. */
  tier2SyncNow: boolean;
  /** How long to wait for the file to appear after a nudge, in seconds. */
  timeoutSeconds: number;
  /** Poll cadence while waiting. Default 1000ms; floored at 100ms. */
  pollIntervalMs?: number;
}

/** Highest tier that actually ran (0 = none). */
export type SyncTier = 0 | 1 | 2;

export interface EnsureDownloadedInput {
  /** Absolute path (already `~`-expanded) we expect the file to appear at. */
  filePath: string;
  /** Chat identifier (handle or GUID) to open in Messages for Tier 1. */
  chatId?: string | null;
  /** `attachment.transfer_state` from chat.db (-1 = undownloaded); advisory. */
  transferState?: number | null;
}

export interface EnsureDownloadedResult {
  /** True iff the file is on disk when we return. */
  downloaded: boolean;
  /** True iff we actually ran at least one tier (vs short-circuited). */
  attempted: boolean;
  /** Highest tier attempted. */
  tier: SyncTier;
  /** Machine-readable reason when not downloaded / skipped. */
  reason?: string;
  /** Human-actionable remediation (e.g. grant Accessibility). */
  hint?: string;
}

/** All side effects the orchestrator needs, injectable for tests. */
export interface AttachmentSyncDeps {
  fileExists(path: string): boolean;
  openConversation(chatId: string): Promise<void>;
  syncNow(): Promise<SyncNowOutcome>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Production deps: real fs + timers + AppleScript (AppleScript self-mocks under Vitest). */
export function defaultAttachmentSyncDeps(): AttachmentSyncDeps {
  return {
    fileExists: (p) => existsSync(p),
    openConversation: (chatId) => openConversationInMessages(chatId),
    syncNow: () => syncNowViaSystemEvents(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Poll `fileExists` until it's true or `timeoutMs` elapses (measured against
 * `deps.now()`). Checks immediately first — opening the chat may have already
 * pulled the file — then sleeps `pollIntervalMs` between checks.
 */
async function pollForFile(
  deps: AttachmentSyncDeps,
  path: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const start = deps.now();
  if (deps.fileExists(path)) return true;
  while (deps.now() - start < timeoutMs) {
    await deps.sleep(pollIntervalMs);
    if (deps.fileExists(path)) return true;
  }
  return false;
}

/**
 * Ensure `input.filePath` is on disk, nudging Messages to download it if not.
 * Best-effort: returns a structured result rather than throwing. Idempotent and
 * cheap when the file already exists (no side effects) or when disabled.
 */
export async function ensureAttachmentDownloaded(
  input: EnsureDownloadedInput,
  config: AttachmentSyncConfig,
  deps: AttachmentSyncDeps = defaultAttachmentSyncDeps(),
): Promise<EnsureDownloadedResult> {
  const { filePath } = input;

  // Already on disk → nothing to do (no app launch).
  if (deps.fileExists(filePath)) {
    return { downloaded: true, attempted: false, tier: 0 };
  }
  if (!config.enabled) {
    return { downloaded: false, attempted: false, tier: 0, reason: "sync nudge disabled" };
  }

  const pollIntervalMs = Math.max(100, config.pollIntervalMs ?? 1000);
  const timeoutMs = Math.max(1000, config.timeoutSeconds * 1000);
  let tier: SyncTier = 0;
  let hint: string | undefined;

  // ── Tier 1: open the conversation so Messages pulls its media ──
  if (input.chatId) {
    tier = 1;
    try {
      await deps.openConversation(input.chatId);
    } catch (e) {
      hint = `Could not open the conversation in Messages: ${errMsg(e)}`;
    }
    if (await pollForFile(deps, filePath, timeoutMs, pollIntervalMs)) {
      return { downloaded: true, attempted: true, tier };
    }
  } else {
    hint = "No chat identifier available to open the conversation in Messages.";
  }

  // ── Tier 2 (opt-in): System Events "Sync Now" ──
  if (config.tier2SyncNow) {
    tier = 2;
    const outcome = await deps.syncNow();
    if (!outcome.ok) {
      if (outcome.needsAccessibility) {
        return {
          downloaded: deps.fileExists(filePath),
          attempted: true,
          tier,
          reason: "accessibility-permission-required",
          hint: "Sync Now needs Accessibility permission. Grant it in System Settings ▸ Privacy & Security ▸ Accessibility for your terminal/IDE, then retry.",
        };
      }
      hint = outcome.error ?? hint ?? "Sync Now failed.";
    } else if (await pollForFile(deps, filePath, timeoutMs, pollIntervalMs)) {
      return { downloaded: true, attempted: true, tier };
    }
  }

  return {
    downloaded: deps.fileExists(filePath),
    attempted: tier > 0,
    tier,
    reason: tier === 0 ? "no sync tier could run" : "attachment did not download in time",
    hint,
  };
}
