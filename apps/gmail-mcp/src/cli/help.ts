// Shared CLI help/banner output. Used by both `gmail-mcp auth` (legacy
// entry, preserved for backwards compat) and `gmail-cli auth` (canonical
// entry) so the precedence table renders identically.

import { DEFAULT_SCOPES, getAvailableScopeNames } from "../scopes.js";

/**
 * Print the OAuth scope precedence table to stderr. Trigger this on bare
 * `gmail-mcp auth` invocation (no flags) as a teaching moment for first-time
 * users — they see all four scope sources at once.
 */
export function printAuthSourcesHelp(
  write: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): void {
  write("Gmail MCP authentication");
  write("");
  write("Scope source precedence (first match wins):");
  write("  1. --scopes=gmail.modify,gmail.compose      CLI flag (comma- or space-separated)");
  write("  2. GMAIL_SCOPES env var                     same syntax as --scopes");
  write("     `pnpm run cli auth` / `npm run cli auth` auto-load .env and .env.local");
  write("  3. Interactive checkbox prompt              (TTY only)");
  write("  4. Defaults                                 used when --non-interactive,");
  write("                                              CI=true, GMAIL_AUTH_NON_INTERACTIVE=1,");
  write("                                              or stdin is not a TTY");
  write("");
  write(`Available scopes: ${getAvailableScopeNames().join(", ")}`);
  write(`Defaults:         ${DEFAULT_SCOPES.join(", ")}`);
  write("");
}
