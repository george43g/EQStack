// `gmail-cli serve` — runs the MCP server.
//
// Default transport is stdio (same as the `gmail-mcp` bin). Add `--http`
// to expose the same MCP via Streamable HTTP — useful for running on a
// remote server (Cloud Run, Fly, Pi, VPS) and connecting MCP hosts over
// HTTPS instead of stdio.
//
// Bearer-token auth on /mcp; /health is open. TLS is delegated to a
// reverse proxy (Caddy / nginx / Cloudflare Tunnel). See README operator
// recipes.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

export interface ServeCommandOptions {
  http?: boolean;
  port?: number;
  bind?: string;
  tokenEnv?: string;
}

export function buildServeCommand(): Command {
  const cmd = new Command("serve");
  cmd
    .description("Run the gmail-mcp MCP server (stdio by default; --http for remote-mode)")
    .option("--http", "Expose the MCP via Streamable HTTP instead of stdio")
    .option("--port <n>", "HTTP port (default: 8080)", (v) => Number.parseInt(v, 10), 8080)
    .option(
      "--bind <addr>",
      "HTTP bind address (default: 127.0.0.1; set 0.0.0.0 for direct internet — use a reverse proxy instead)",
      "127.0.0.1",
    )
    .option(
      "--token-env <name>",
      "Name of env var holding the bearer token (default: GMAIL_HTTP_TOKEN). Server refuses to start if unset.",
      "GMAIL_HTTP_TOKEN",
    )
    .action((options: ServeCommandOptions) => {
      // We delegate to the existing gmail-mcp entry point so the entire
      // bootstrap (shutdown handlers, watchdog, OAuth credentials, dispatcher
      // wiring) runs in one place.
      const here = path.dirname(fileURLToPath(import.meta.url));
      // Try built path first (dist/cli/commands/serve.js → dist/index.js)
      // then dev path (src/cli/commands/serve.ts → src/index.ts).
      const builtMcpEntry = path.resolve(here, "..", "..", "index.js");
      const args: string[] = [];
      if (options.http) args.push("--http");
      if (options.port !== undefined) args.push(`--port=${options.port}`);
      if (options.bind) args.push(`--bind=${options.bind}`);
      if (options.tokenEnv) args.push(`--token-env=${options.tokenEnv}`);

      const child = spawn(process.execPath, [builtMcpEntry, ...args], {
        stdio: "inherit",
        env: process.env,
      });
      child.on("exit", (code, signal) => {
        process.exit(code ?? (signal ? 128 : 0));
      });
    });
  return cmd;
}
