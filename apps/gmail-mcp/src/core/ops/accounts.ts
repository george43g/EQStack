// list_accounts + switch_account ops (Phase M2-light).
//
// Two meta-tools that operate on the local account manifest, never on Gmail:
//
//   list_accounts   — read.  Returns the manifest + which account is active.
//                     `readOnlyHint: true` so hosts allow it freely.
//   switch_account  — write. Loads credentials for a named account and swaps
//                     the session singletons. Hosts can permission-gate.
//
// Neither requires a Gmail scope; both run before any Gmail API call. The
// switch is best-effort relative to scopes — if the new account has narrower
// scopes than the previous one, the host's cached tools/list is stale and
// affected tools will reject at call-time with the usual re-auth hint.

import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import type { z } from "zod";
import { info as logInfo } from "../../robustness/index.js";
import {
  ListAccountsOutputSchema,
  ListAccountsSchema,
  SwitchAccountOutputSchema,
  SwitchAccountSchema,
} from "../../tools.js";
import {
  AccountNotFoundError,
  listAccounts,
  loadManifest,
  resolveActiveAccount,
  validateAccountId,
} from "../accounts.js";
import { loadOAuthKeys } from "../auth-flow.js";
import { getConfigDir, getOAuthPath } from "../config-paths.js";
import { loadCredentials } from "../credentials.js";
import { type Operation, registry } from "../registry.js";
import { getCurrentAccountId, setSession } from "../session.js";

type ListAccountsInput = z.infer<typeof ListAccountsSchema>;
type ListAccountsOutput = z.infer<typeof ListAccountsOutputSchema>;
type SwitchAccountInput = z.infer<typeof SwitchAccountSchema>;
type SwitchAccountOutput = z.infer<typeof SwitchAccountOutputSchema>;

const listOp: Operation<ListAccountsInput, ListAccountsOutput> = {
  name: "list_accounts",
  schema: ListAccountsSchema,
  outputSchema: ListAccountsOutputSchema,
  scopes: [],
  handler: async (_input, _ctx) => {
    const active = resolveActiveAccount();
    const items = listAccounts();
    const currentSessionAccount = getCurrentAccountId();

    // "Active" for display purposes: prefer the session's actually-loaded
    // account (i.e. what the next tool call will hit) over the manifest's
    // would-be active. Differs only briefly after a switch_account error or
    // before any bootstrap has happened.
    const activeIdForDisplay = currentSessionAccount ?? active.id;

    const accounts: ListAccountsOutput["accounts"] = items.map((item) => ({
      id: item.id,
      emailAddress: item.entry.emailAddress ?? null,
      scopes: item.entry.scopes ?? null,
      isDefault: item.isDefault,
      isActive: item.id === activeIdForDisplay,
      createdAt: item.entry.createdAt ?? null,
    }));

    const structured: ListAccountsOutput = {
      active: {
        id: activeIdForDisplay ?? null,
        source: active.source,
        isLegacyImplicit: active.isLegacyImplicit,
      },
      count: accounts.length,
      accounts,
    };

    // Human-readable text for the legacy MCP envelope.
    const lines: string[] = [];
    if (accounts.length === 0) {
      lines.push("No accounts in the manifest yet.");
      lines.push("Run `gmail auth --account <id>` from the shell to add one.");
    } else {
      lines.push(`${accounts.length} account(s) configured:`);
      for (const a of accounts) {
        const markers: string[] = [];
        if (a.isActive) markers.push("ACTIVE");
        if (a.isDefault) markers.push("default");
        const tag = markers.length > 0 ? `  [${markers.join(", ")}]` : "";
        const email = a.emailAddress ? ` <${a.emailAddress}>` : "";
        const scopes = a.scopes ? ` scopes=${a.scopes.join(",")}` : "";
        lines.push(`  - ${a.id}${email}${scopes}${tag}`);
      }
      lines.push("");
      lines.push(`Active: ${activeIdForDisplay ?? "(none)"} (source: ${active.source})`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured,
    };
  },
};

const switchOp: Operation<SwitchAccountInput, SwitchAccountOutput> = {
  name: "switch_account",
  schema: SwitchAccountSchema,
  outputSchema: SwitchAccountOutputSchema,
  scopes: [],
  handler: async (input, _ctx) => {
    const { accountId } = input;
    validateAccountId(accountId);

    const manifest = loadManifest();
    if (!manifest || !manifest.accounts[accountId]) {
      throw new AccountNotFoundError(accountId);
    }

    const previousAccountId = getCurrentAccountId();

    // No-op fast path: switching to the already-active account succeeds
    // without re-reading credentials. Idempotent.
    if (previousAccountId === accountId) {
      const entry = manifest.accounts[accountId];
      const structured: SwitchAccountOutput = {
        previousAccountId,
        newAccountId: accountId,
        emailAddress: entry?.emailAddress ?? null,
        scopes: entry?.scopes ?? [],
        note: "Account was already active. No session change.",
      };
      return {
        content: [{ type: "text", text: `Account "${accountId}" is already active. No change.` }],
        structuredContent: structured,
      };
    }

    const env = process.env;

    // Fixture-mode short-circuit: skip OAuth + credentials entirely; swap in
    // a new GmailFixtureClient for the named account dir. The OAuth2Client
    // proxy stays throwing-on-access (same contract as bootstrap fixture mode).
    if (env.GMAIL_FIXTURE_MODE === "1") {
      const fixtureDir = env.GMAIL_FIXTURE_DIR ?? "./fixtures/gmail";
      const { loadFixtureGmail } = await import("../../fixtures/loader.js");
      let bundle;
      try {
        bundle = loadFixtureGmail(fixtureDir, accountId);
      } catch (err) {
        throw new Error(
          `switch_account: failed to load fixture client for "${accountId}": ${(err as Error).message}`,
        );
      }
      const stubOAuth = new Proxy({} as OAuth2Client, {
        get: () => {
          throw new Error(
            "OAuth2Client is stubbed in fixture mode — production code MUST NOT depend on it.",
          );
        },
      });
      setSession({
        oauth2Client: stubOAuth,
        gmail: bundle.gmail,
        authorizedScopes: bundle.scopes,
        accountId,
      });
      logInfo("account swapped (fixture)", {
        account: accountId,
        previousAccount: previousAccountId,
        scopes: bundle.scopes,
      });

      const entry = manifest.accounts[accountId];
      const structured: SwitchAccountOutput = {
        previousAccountId: previousAccountId ?? null,
        newAccountId: accountId,
        emailAddress: entry?.emailAddress ?? null,
        scopes: bundle.scopes,
        note: "Active account swapped (fixture mode).",
      };
      const lines = [
        `Switched active Gmail account: ${previousAccountId ?? "(none)"} → ${accountId} (fixture)`,
        `Scopes now granted: ${bundle.scopes.length > 0 ? bundle.scopes.join(", ") : "(none)"}`,
      ];
      if (entry?.emailAddress) lines.push(`Email: ${entry.emailAddress}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: structured,
      };
    }

    const configDir = getConfigDir(env);
    const oauthPath = getOAuthPath(env);

    let keys;
    try {
      keys = loadOAuthKeys({
        oauthPath,
        cwd: process.cwd(),
        configDir,
        accountId,
      });
    } catch (err) {
      throw new Error(
        `switch_account: failed to load OAuth keys for "${accountId}": ${(err as Error).message}`,
      );
    }

    let loaded;
    try {
      loaded = await loadCredentials({ env, accountId });
    } catch (err) {
      throw new Error(
        `switch_account: failed to load credentials for "${accountId}": ${(err as Error).message}. Run \`gmail auth --account ${accountId}\` to mint them.`,
      );
    }

    const oauth2Client = new OAuth2Client(
      keys.client_id,
      keys.client_secret,
      "http://localhost:3000/oauth2callback",
    );
    oauth2Client.setCredentials(loaded.credentials.tokens);
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const scopes = loaded.credentials.scopes ?? [];
    setSession({ oauth2Client, gmail, authorizedScopes: scopes, accountId });
    logInfo("account swapped", {
      account: accountId,
      previousAccount: previousAccountId,
      scopes,
    });

    const entry = manifest.accounts[accountId];
    const structured: SwitchAccountOutput = {
      previousAccountId: previousAccountId ?? null,
      newAccountId: accountId,
      emailAddress: entry?.emailAddress ?? null,
      scopes,
      note: "Active account swapped. The host's cached tools/list does not auto-refresh; tools relying on scopes the new account lacks will reject at call-time.",
    };

    const lines = [
      `Switched active Gmail account: ${previousAccountId ?? "(none)"} → ${accountId}`,
      `Scopes now granted: ${scopes.length > 0 ? scopes.join(", ") : "(none)"}`,
    ];
    if (entry?.emailAddress) lines.push(`Email: ${entry.emailAddress}`);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured,
    };
  },
};

registry.register(listOp);
registry.register(switchOp);
