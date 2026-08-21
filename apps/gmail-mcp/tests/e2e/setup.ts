// E2E global setup: stand up a self-contained .test-config/ that points at
// the committed fixture corpus. Runs once per `pnpm test:e2e` invocation.
//
// Writes:
//   .test-config/accounts.json     — manifest mapping work + personal
//   .test-config/accounts/work/credentials.json     — placeholder (fixture mode)
//   .test-config/accounts/personal/credentials.json — placeholder
//
// The actual gmail handle in fixture mode is the GmailFixtureClient backed
// by fixtures/gmail/<account>/. Credentials files only need to exist so the
// loader's "missing credentials" branch doesn't trip when the manifest is
// consulted in other code paths.

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const TEST_CONFIG = path.join(REPO_ROOT, ".test-config");

function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function setup(): Promise<void> {
  // Force GMAIL_FIXTURE_MODE on for the entire e2e run. Setting in setup
  // means individual tests don't have to repeat the wiring.
  process.env.GMAIL_FIXTURE_MODE = "1";
  process.env.GMAIL_FIXTURE_DIR = path.join(REPO_ROOT, "fixtures", "gmail");
  process.env.GMAIL_CONFIG_DIR = TEST_CONFIG;
  process.env.GMAIL_ACCOUNT = "work";

  // Wipe + rebuild .test-config so each run is hermetic.
  if (fs.existsSync(TEST_CONFIG)) fs.rmSync(TEST_CONFIG, { recursive: true, force: true });

  const now = new Date().toISOString();
  writeJson(path.join(TEST_CONFIG, "accounts.json"), {
    defaultAccount: "work",
    accounts: {
      work: { createdAt: now, emailAddress: "user-work@fixture.test", scopes: ["gmail.modify"] },
      personal: {
        createdAt: now,
        emailAddress: "user-personal@fixture.test",
        scopes: ["gmail.readonly"],
      },
    },
  });
  writeJson(path.join(TEST_CONFIG, "accounts", "work", "credentials.json"), {
    tokens: { access_token: "fixture-work-token" },
    scopes: ["gmail.modify"],
  });
  writeJson(path.join(TEST_CONFIG, "accounts", "personal", "credentials.json"), {
    tokens: { access_token: "fixture-personal-token" },
    scopes: ["gmail.readonly"],
  });
}

export async function teardown(): Promise<void> {
  if (fs.existsSync(TEST_CONFIG)) fs.rmSync(TEST_CONFIG, { recursive: true, force: true });
}
