// E2E against the built `dist/cli/index.js` binary. Spawns the CLI as a
// subprocess with the e2e environment so we exercise the actual published
// shape (commander wiring, env loading, exit codes) — not just in-process
// imports.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_BIN = path.join(REPO_ROOT, "dist/cli/index.js");
const NODE = process.execPath;

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(NODE, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("e2e: gmail CLI binary against fixtures", () => {
  it("`gmail account list --json` returns the fixture manifest", () => {
    const { status, stdout } = runCli(["account", "list", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as Array<{ id: string; isDefault: boolean }>;
    expect(parsed.map((a) => a.id).sort()).toEqual(["personal", "work"]);
    expect(parsed.find((a) => a.id === "work")?.isDefault).toBe(true);
  });

  it("`gmail account current --json` reports work as the active account", () => {
    const { status, stdout } = runCli(["account", "current", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { id: string; source: string };
    expect(parsed.id).toBe("work");
    // Source is "env" because the e2e setup stamps GMAIL_ACCOUNT=work into
    // the subprocess env. Either source is valid — assert the chain resolved.
    expect(["env", "manifest-default"]).toContain(parsed.source);
  });

  it("`gmail search 'in:inbox' --json` returns fixture results for the work account", () => {
    const { status, stdout } = runCli(["search", "in:inbox", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      resultCount: number;
      results: Array<{ id: string | null; subject?: string }>;
    };
    expect(parsed.resultCount).toBeGreaterThanOrEqual(2);
    // Work-account fixture messages all have subjects we can spot-check.
    const subjects = parsed.results.map((r) => r.subject ?? "");
    expect(subjects.some((s) => s.includes("Release 1.2.3"))).toBe(true);
  });

  it("`gmail --account personal search 'in:inbox' --json` returns personal-account results", () => {
    const { status, stdout } = runCli(["--account", "personal", "search", "in:inbox", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      resultCount: number;
      results: Array<{ subject?: string }>;
    };
    expect(parsed.resultCount).toBeGreaterThanOrEqual(1);
    const subjects = parsed.results.map((r) => r.subject ?? "");
    expect(subjects.some((s) => s.toLowerCase().includes("newsletter"))).toBe(true);
    // Cross-check: work-account subjects should NOT appear under personal.
    expect(subjects.some((s) => s.includes("Release 1.2.3"))).toBe(false);
  });

  it("`gmail health --json` returns a status snapshot without touching Gmail", () => {
    const { status, stdout } = runCli(["health", "--json"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { status: string; pid: number };
    expect(["healthy", "degraded", "unhealthy"]).toContain(parsed.status);
    expect(typeof parsed.pid).toBe("number");
  });

  it("runs the draft lifecycle through the built CLI", () => {
    const created = runCli([
      "draft",
      "--to",
      "recipient@example.com",
      "--subject",
      "Fixture draft",
      "--body",
      "Initial body",
      "--json",
    ]);
    expect(created.status).toBe(0);
    const createdJson = JSON.parse(created.stdout) as { draftId: string; messageId: string };
    expect(createdJson.draftId).toMatch(/^fixture-draft-/);
    expect(createdJson.messageId).toBe(createdJson.draftId);

    const updated = runCli([
      "update-draft",
      createdJson.draftId,
      "--to",
      "recipient@example.com",
      "--subject",
      "Updated fixture draft",
      "--body",
      "Updated body",
      "--json",
    ]);
    expect(updated.status).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({
      draftId: createdJson.draftId,
      status: "updated",
    });

    const sent = runCli(["send-draft", createdJson.draftId, "--json"]);
    expect(sent.status).toBe(0);
    expect(JSON.parse(sent.stdout)).toMatchObject({
      draftId: createdJson.draftId,
      status: "sent",
    });

    const deleted = runCli(["delete-draft", createdJson.draftId, "--json"]);
    expect(deleted.status).toBe(0);
    expect(JSON.parse(deleted.stdout)).toEqual({
      draftId: createdJson.draftId,
      status: "deleted",
    });
  });

  it("marks one or many fixture messages as spam through phishing aliases", () => {
    const single = runCli(["report-phishing", "w_msg_001", "--json"]);
    expect(single.status).toBe(0);
    expect(JSON.parse(single.stdout)).toMatchObject({
      messageId: "w_msg_001",
      labelApplied: "SPAM",
      status: "reported_as_spam",
      limitation: expect.stringContaining("no native phishing-report endpoint"),
    });

    const batch = runCli([
      "batch-report-phishing",
      "--ids",
      "w_msg_001,w_msg_002",
      "--json",
    ]);
    expect(batch.status).toBe(0);
    expect(JSON.parse(batch.stdout)).toMatchObject({
      action: "report_phishing",
      successCount: 2,
      failureCount: 0,
      failures: [],
    });
  });

  it("requires gmail.full for permanent deletion", () => {
    const result = runCli(["delete", "w_msg_001", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Tool \\"delete_email\\" is not available');
    expect(result.stdout).toContain("additional scopes");
  });

  it("advertises and accepts prefixed MCP tool names", async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const transport = new StdioClientTransport({
      command: NODE,
      args: [CLI_BIN, "mcp", "--tool-prefix", "fixture_"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "fixture-e2e", version: "1.0.0" });
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      // The work fixture grants gmail.modify + gmail.settings.basic, so the
      // catalog excludes only the gmail.full tools (delete_email,
      // batch_delete_emails) and exposes the settings-scoped tools (the 5
      // filter ops + list_send_identities) plus the cross-account
      // unread_summary meta-tool and the read-only list_drafts op.
      expect(catalog.tools.length).toBe(34);
      expect(catalog.tools.every((tool) => tool.name.startsWith("fixture_"))).toBe(true);
      expect(catalog.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "fixture_send_draft",
          "fixture_update_draft",
          "fixture_delete_draft",
          "fixture_list_drafts",
          "fixture_report_phishing",
          "fixture_batch_report_phishing",
          "fixture_list_send_identities",
          "fixture_unread_summary",
        ]),
      );

      const result = await client.callTool({ name: "fixture_health_check", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text" })]),
      );
    } finally {
      await client.close();
    }
  });

  it("exposes the full 36-tool catalog for a gmail.full account", async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    // The `full` fixture account grants gmail.full + gmail.settings.basic, so
    // every tool is in scope — including the two gmail.full-only deletion tools
    // hidden from the work account's 34-tool catalog.
    env.GMAIL_ACCOUNT = "full";
    const transport = new StdioClientTransport({
      command: NODE,
      args: [CLI_BIN, "mcp"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "fixture-full-e2e", version: "1.0.0" });
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      expect(catalog.tools.length).toBe(36);
      const names = catalog.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(["delete_email", "batch_delete_emails", "list_drafts"]),
      );

      // delete_email is dispatchable (fixture delete returns canned success).
      const deleted = await client.callTool({
        name: "delete_email",
        arguments: { messageId: "f_msg_001" },
      });
      expect(deleted.isError).not.toBe(true);
      expect(deleted.structuredContent).toMatchObject({
        messageId: "f_msg_001",
        status: "deleted",
      });
    } finally {
      await client.close();
    }
  });

  it("`gmail console` processes piped account/scope browsing without mixing single-account inboxes", () => {
    const script = [
      "accounts",
      "switch personal",
      "inbox 5",
      "switch work",
      "inbox 5",
      "scope all",
      "inbox 5",
      "quit",
      "",
    ].join("\n");
    const { status, stdout, stderr } = runCli(["console"], {}, script);

    expect(status).toBe(0);
    expect(stderr).toBe("");
    const personalSection = stdout.slice(
      stdout.indexOf("Switched active Gmail account: work"),
      stdout.indexOf("Switched active Gmail account: personal"),
    );
    expect(personalSection).toContain("p_thr_001");
    expect(personalSection).not.toContain("w_thr_001");

    const workSection = stdout.slice(
      stdout.indexOf("Switched active Gmail account: personal"),
      stdout.indexOf("Browse scope: all accounts"),
    );
    expect(workSection).toContain("w_thr_001");
    expect(workSection).not.toContain("p_thr_001");

    const combinedSection = stdout.slice(stdout.indexOf("Browse scope: all accounts"));
    expect(combinedSection).toContain("[work<user-work@fixture.test>]");
    expect(combinedSection).toContain("[personal<user-personal@fixture.test>]");
    expect(combinedSection).toContain("w_thr_001");
    expect(combinedSection).toContain("p_thr_001");
  });
});
