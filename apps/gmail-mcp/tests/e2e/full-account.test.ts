// End-to-end coverage for the `gmail.full` fixture account (Milestone D1).
//
// Exercises the richer corpus that the work/personal accounts don't carry:
// a multipart/alternative HTML body, a multipart/mixed message with a real
// attachment part (download_attachment), and a deep 5-message thread. Boots
// the dispatcher in fixture mode with GMAIL_ACCOUNT=full so the full 35-tool
// catalog is in scope.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetForTests as resetSession } from "../../src/core/session.js";
import { _resetDispatcherForTests, bootstrapSession, callMcpTool } from "../../src/index.js";

beforeEach(() => {
  resetSession();
  _resetDispatcherForTests();
  process.env.GMAIL_ACCOUNT = "full";
});

afterEach(() => {
  resetSession();
  _resetDispatcherForTests();
  // Restore the suite default so later e2e files see the work account.
  process.env.GMAIL_ACCOUNT = "work";
});

describe("e2e: gmail.full fixture account", () => {
  it("boots with full+settings scopes and reads a multipart/alternative HTML body", async () => {
    const bundle = await bootstrapSession();
    expect(bundle.accountId).toBe("full");
    expect(bundle.authorizedScopes).toEqual(["gmail.full", "gmail.settings.basic"]);

    const result = await callMcpTool("read_email", { messageId: "f_msg_002" });
    expect(result.isError).not.toBe(true);
    const struct = result.structuredContent as { bodyHtml: string; subject: string };
    expect(struct.subject).toContain("Weekly digest");
    expect(struct.bodyHtml).toContain("<h1>Weekly Digest</h1>");
  });

  it("surfaces attachment metadata and downloads the attachment bytes", async () => {
    await bootstrapSession();

    const read = await callMcpTool("read_email", { messageId: "f_msg_003" });
    const meta = read.structuredContent as {
      attachments: Array<{ id: string; filename: string; mimeType: string }>;
    };
    expect(meta.attachments).toHaveLength(1);
    expect(meta.attachments[0]).toMatchObject({
      id: "att_001",
      filename: "quarterly-report.pdf",
      mimeType: "application/pdf",
    });

    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-full-att-"));
    try {
      const dl = await callMcpTool("download_attachment", {
        messageId: "f_msg_003",
        attachmentId: "att_001",
        savePath: saveDir,
      });
      expect(dl.isError).not.toBe(true);
      const out = dl.structuredContent as { path: string; filename: string; size: number };
      expect(out.filename).toBe("quarterly-report.pdf");
      expect(out.size).toBe(94);
      const written = fs.readFileSync(out.path, "utf8");
      expect(written).toMatch(/download_attachment coverage/);
    } finally {
      fs.rmSync(saveDir, { recursive: true, force: true });
    }
  });

  it("get_thread enumerates the deep 5-message migration thread", async () => {
    await bootstrapSession();
    const result = await callMcpTool("get_thread", { threadId: "f_thr_100" });
    expect(result.isError).not.toBe(true);
    const struct = result.structuredContent as {
      messageCount: number;
      total_available: number;
      truncated: boolean;
      messages: Array<{ messageId: string }>;
    };
    expect(struct.messageCount).toBe(5);
    expect(struct.total_available).toBe(5);
    expect(struct.truncated).toBe(false);
    expect(struct.messages.map((m) => m.messageId)).toContain("f_msg_105");
  });

  it("delete_email happy-path is dispatchable under gmail.full", async () => {
    await bootstrapSession();
    const result = await callMcpTool("delete_email", { messageId: "f_msg_004" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      messageId: "f_msg_004",
      status: "deleted",
    });
  });
});
