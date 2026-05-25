// Fixture-mode loader: builds a GmailFixtureClient for the resolved active
// account. Used by `bootstrapSession` when GMAIL_FIXTURE_MODE=1.

import fs from "node:fs";
import path from "node:path";
import type { gmail_v1 } from "googleapis";
import { GmailFixtureClient, readFixtureScopes } from "./gmail-fixture-client.js";

export interface FixtureBundle {
  gmail: gmail_v1.Gmail;
  scopes: string[];
  /** Absolute path the client reads from — surfaced for diagnostics. */
  accountDir: string;
}

export function loadFixtureGmail(fixtureDir: string, accountId: string | null): FixtureBundle {
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(
      `GMAIL_FIXTURE_DIR ${fixtureDir} does not exist. Create fixtures under fixtures/gmail/<accountId>/ or unset GMAIL_FIXTURE_MODE.`,
    );
  }

  // Default to the first dir under fixtureDir when no account is named.
  const id = accountId ?? defaultAccountId(fixtureDir);
  if (!id) {
    throw new Error(
      `GMAIL_FIXTURE_MODE=1 but no fixture account is configured. Set GMAIL_ACCOUNT or create fixtures/gmail/<id>/.`,
    );
  }

  const accountDir = path.join(fixtureDir, id);
  if (!fs.existsSync(accountDir)) {
    throw new Error(
      `Fixture account dir ${accountDir} does not exist. Available: ${listAccounts(fixtureDir).join(", ") || "(none)"}`,
    );
  }

  const client = new GmailFixtureClient(accountDir);
  return {
    // The cast lives at this one seam — every method in GmailFixtureClient
    // that the ops actually invoke is implemented. Anything unimplemented
    // throws at first call, surfacing the gap immediately rather than
    // silently returning undefined.
    gmail: client as unknown as gmail_v1.Gmail,
    scopes: readFixtureScopes(accountDir),
    accountDir,
  };
}

function listAccounts(fixtureDir: string): string[] {
  if (!fs.existsSync(fixtureDir)) return [];
  return fs
    .readdirSync(fixtureDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function defaultAccountId(fixtureDir: string): string | null {
  const accounts = listAccounts(fixtureDir);
  return accounts[0] ?? null;
}
