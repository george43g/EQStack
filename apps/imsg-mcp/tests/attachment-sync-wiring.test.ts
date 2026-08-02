/**
 * Source-assertion: the Stage-7 sync nudge stays wired into every call site the
 * plan names — get_attachment (MCP), export --include-attachments (CLI), and the
 * TUI open/save handlers. Cheap insurance against a refactor silently dropping a
 * surface, and it locks the `nudge.enabled` gate so the nudge can never fire when
 * the user turned it off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const INDEX = read("src", "index.ts");
const CLI = read("src", "cli.ts");
const ACTIONS = read("src", "tui", "attachmentActions.ts");
const APP = read("src", "tui", "App.tsx");
const APPLESCRIPT = read("src", "applescript.ts");
const DB = read("src", "imessage-db.ts");

describe("get_attachment (MCP) nudge wiring", () => {
  it("nudges on a missing file, gated by nudge.enabled, then re-checks disk", () => {
    expect(INDEX).toContain("ensureAttachmentDownloaded");
    // Nudge only runs behind the config gate.
    expect(INDEX).toMatch(/nudge\.enabled/);
    // Resolves the owning chat identifier for Tier 1.
    expect(INDEX).toContain("getAttachmentDownloadInfo");
    // Re-checks existsSync after the nudge before erroring.
    expect(INDEX).toMatch(/ensureAttachmentDownloaded[\s\S]{0,400}existsSync\(resolvedPath\)/);
  });
});

describe("export --include-attachments (CLI) nudge wiring", () => {
  it("opens the conversation once for a missing attachment, gated by nudge.enabled", () => {
    expect(CLI).toContain("ensureAttachmentDownloaded");
    expect(CLI).toMatch(/nudge\.enabled/);
    expect(CLI).toContain("resolveInterpretConfig");
  });
});

describe("TUI open/save nudge wiring", () => {
  it("attachmentActions exports the nudge helpers", () => {
    expect(ACTIONS).toContain("export async function nudgeAttachmentDownload");
    expect(ACTIONS).toContain("export async function openAttachmentWithNudge");
    expect(ACTIONS).toContain("export async function saveAttachmentWithNudge");
    // Returns true without status noise when the file is already present.
    expect(ACTIONS).toMatch(/if \(existsSync\(filePath\)\) return true/);
  });

  it("App.tsx routes open/save through the nudge-aware helpers", () => {
    expect(APP).toContain("openAttachmentWithNudge");
    expect(APP).toContain("saveAttachmentWithNudge");
    expect(APP).toContain("nudgeAttachmentDownload");
    // Passes the live thread's identifier + resolved nudge config through.
    expect(APP).toMatch(/openAttachmentWithNudge\([\s\S]{0,200}resolveInterpretConfig\(\)\.nudge/);
  });
});

describe("AppleScript primitives (MOCK-branched)", () => {
  it("exports the T1/T2 primitives and the open-URL builder", () => {
    expect(APPLESCRIPT).toContain("export function buildImessageOpenUrl");
    expect(APPLESCRIPT).toContain("export async function openConversationInMessages");
    expect(APPLESCRIPT).toContain("export async function syncNowViaSystemEvents");
    // Both real-app primitives short-circuit under mock.
    expect(APPLESCRIPT).toMatch(/openConversationInMessages[\s\S]{0,120}if \(MOCK\) return/);
    expect(APPLESCRIPT).toMatch(
      /syncNowViaSystemEvents[\s\S]{0,200}if \(MOCK\) return \{ ok: true \}/,
    );
    // The imessage:// URL is flagged for supervised verification, not shipped blind.
    expect(APPLESCRIPT).toMatch(/NEEDS SUPERVISED LIVE VERIFICATION/);
  });
});

describe("DB download context", () => {
  it("exposes transfer_state + owning chat identifier for a ROWID", () => {
    expect(DB).toContain("getAttachmentDownloadInfo");
    expect(DB).toMatch(/transfer_state/);
    expect(DB).toContain("chat_identifier as chatIdentifier");
  });
});
