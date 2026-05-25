// Validates GMAIL_FIXTURE_MODE end-to-end: bootstrapSession picks up the
// env, installs the fixture client, and the dispatcher routes real ops
// (list_inbox_threads, list_email_labels) through it. This is the test
// the e2e suite (Step 7) will lean on for higher-level scenarios.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetForTests as resetSession } from "../core/session.js";
import { _resetDispatcherForTests, bootstrapSession, callMcpTool } from "../index.js";

const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "fixtures", "gmail");

let originalEnv: typeof process.env;

beforeEach(() => {
  originalEnv = { ...process.env };
  // Scrub all credential-source env vars so the test is hermetic.
  for (const k of [
    "GMAIL_CONFIG_DIR",
    "GMAIL_ACCOUNT",
    "GMAIL_CREDENTIALS_JSON",
    "GMAIL_CREDENTIALS_OP",
    "GMAIL_CREDENTIALS_PATH",
    "GMAIL_OAUTH_KEYS_JSON",
    "GMAIL_OAUTH_PATH",
  ]) {
    delete process.env[k];
  }
  resetSession();
  _resetDispatcherForTests();
});

afterEach(() => {
  process.env = originalEnv;
  resetSession();
  _resetDispatcherForTests();
});

describe("fixture-mode bootstrap end-to-end", () => {
  it("boots against fixture data and serves list_email_labels via the dispatcher", async () => {
    process.env.GMAIL_FIXTURE_MODE = "1";
    process.env.GMAIL_FIXTURE_DIR = FIXTURE_ROOT;
    process.env.GMAIL_ACCOUNT = "work";

    const bundle = await bootstrapSession();
    expect(bundle.accountId).toBe("work");
    expect(bundle.authorizedScopes).toEqual(["gmail.modify"]);

    const result = await callMcpTool("list_email_labels", {});
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      count: { total: number; system: number; user: number };
      system: Array<{ id: string }>;
      user: Array<{ id: string }>;
    };
    expect(structured.count.total).toBeGreaterThanOrEqual(5);
    expect(structured.user.find((l) => l.id === "Label_1")).toBeDefined();
  });

  it("serves the personal account when GMAIL_ACCOUNT=personal", async () => {
    process.env.GMAIL_FIXTURE_MODE = "1";
    process.env.GMAIL_FIXTURE_DIR = FIXTURE_ROOT;
    process.env.GMAIL_ACCOUNT = "personal";

    const bundle = await bootstrapSession();
    expect(bundle.accountId).toBe("personal");
    expect(bundle.authorizedScopes).toEqual(["gmail.readonly"]);

    const labels = await callMcpTool("list_email_labels", {});
    const structured = labels.structuredContent as {
      user: Array<{ id: string; name?: string }>;
    };
    expect(structured.user.find((l) => l.name === "Newsletters")).toBeDefined();
  });

  it("list_inbox_threads returns the work-account threads from fixtures", async () => {
    process.env.GMAIL_FIXTURE_MODE = "1";
    process.env.GMAIL_FIXTURE_DIR = FIXTURE_ROOT;
    process.env.GMAIL_ACCOUNT = "work";

    await bootstrapSession();
    const result = await callMcpTool("list_inbox_threads", { maxResults: 10 });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      resultCount: number;
      threads: Array<{ threadId: string }>;
    };
    expect(structured.threads.length).toBeGreaterThanOrEqual(1);
    expect(structured.threads.find((t) => t.threadId === "w_thr_001")).toBeDefined();
  });

  it("stub OAuth2Client throws if any code path tries to use it under fixture mode", async () => {
    process.env.GMAIL_FIXTURE_MODE = "1";
    process.env.GMAIL_FIXTURE_DIR = FIXTURE_ROOT;
    process.env.GMAIL_ACCOUNT = "work";
    const bundle = await bootstrapSession();
    expect(() => {
      // Any property access on the stub proxy throws — proves we'll catch
      // accidental reliance on the OAuth client in tests.
      void (bundle.oauth2Client as unknown as { refreshAccessToken: unknown }).refreshAccessToken;
    }).toThrow(/stubbed in fixture mode/);
  });

  it("missing fixture dir surfaces a clear error", async () => {
    process.env.GMAIL_FIXTURE_MODE = "1";
    process.env.GMAIL_FIXTURE_DIR = "/nonexistent/fixtures";
    await expect(bootstrapSession()).rejects.toThrow(/GMAIL_FIXTURE_DIR .* does not exist/);
  });

  it("missing account dir lists available accounts in the error", async () => {
    process.env.GMAIL_FIXTURE_MODE = "1";
    process.env.GMAIL_FIXTURE_DIR = FIXTURE_ROOT;
    process.env.GMAIL_ACCOUNT = "ghost";
    await expect(bootstrapSession()).rejects.toThrow(/Available: .*work/);
  });
});
