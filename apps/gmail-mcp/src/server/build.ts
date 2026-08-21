// MCP `Server` factory — builds the SDK Server instance with both handlers
// (tools/list, tools/call) wired to the registry.
//
// Pulled out of src/index.ts in Step 6 of the modular refactor so the stdio
// entry, the HTTP entry, and any future surface can share the same server
// construction. The dispatcher closure captures the OAuth2Client + per-tool
// timeout map + counters via session getters.

import { envNum, noteActivity, ToolTimeoutError, withTimeout } from "@george43g/robustness";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { wrapToolError } from "../auth-errors.js";
import { createContext } from "../core/context.js";
import { registry } from "../core/registry.js";
import {
  getAuthorizedScopes,
  getOAuth2Client,
  incrementToolCallCount,
  recordToolError,
} from "../core/session.js";
import { hasScope } from "../scopes.js";
import { getToolByName, toMcpTools, toolDefinitions } from "../tools.js";
import { VERSION } from "../version.js";
import { canonicalToolName, prefixedToolName } from "./tool-prefix.js";

// Per-tool timeout overrides (ms). Default applies to anything not listed.
// Tunable via MCP_TOOL_TIMEOUT_DEFAULT_MS. Per-tool overrides keep batch /
// send paths from being prematurely killed while keeping reads tight.
// Setting a value to 0 disables the wrapper for that tool.
const DEFAULT_TOOL_TIMEOUT_MS = envNum("MCP_TOOL_TIMEOUT_DEFAULT_MS", 30_000);
const TOOL_TIMEOUTS_MS: Record<string, number> = {
  // Reads — tight, except for list ops whose latency fan-outs scale with
  // maxResults (one threads.get metadata RPC per row). 60s gives a 200-row
  // page enough headroom under transient API slowness; the schema's hard
  // ceiling of 500 still bounds the worst case. Anything larger is a job
  // for the CLI streaming path, not the MCP.
  read_email: 30_000,
  search_emails: 60_000,
  list_inbox_threads: 60_000,
  get_thread: 30_000,
  get_inbox_with_threads: 60_000,
  list_email_labels: 15_000,
  list_filters: 15_000,
  get_filter: 15_000,
  download_email: 60_000,
  download_attachment: 60_000,
  // Writes — slightly looser
  send_email: 60_000,
  draft_email: 60_000,
  send_draft: 60_000,
  update_draft: 60_000,
  delete_draft: 30_000,
  reply_all: 60_000,
  modify_email: 30_000,
  delete_email: 30_000,
  modify_thread: 30_000,
  create_label: 15_000,
  update_label: 15_000,
  delete_label: 15_000,
  get_or_create_label: 15_000,
  create_filter: 15_000,
  delete_filter: 15_000,
  create_filter_from_template: 15_000,
  // Batch — long
  batch_modify_emails: 120_000,
  batch_delete_emails: 120_000,
  report_phishing: 30_000,
  batch_report_phishing: 120_000,
  // Robustness — fast canary, no API call
  health_check: 5_000,
};

export type CallToolFn = (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}>;

/**
 * Build the MCP Server with both request handlers wired up. Returns the
 * server AND the bare dispatcher function so non-stdio callers (CLI / TUI /
 * HTTP wrapper) can call `dispatch(name, args, signal)` without going
 * through the MCP transport.
 *
 * Prerequisite: setSession() must have been called (in main()/bootstrap)
 * so getOAuth2Client(), getAuthorizedScopes(), counters, etc. are valid.
 */
export function buildMcpServer(options: { toolPrefix?: string } = {}): {
  server: Server;
  dispatch: CallToolFn;
} {
  const toolPrefix = options.toolPrefix ?? "";
  const server = new Server(
    {
      name: "gmail",
      version: VERSION,
    },
    {
      capabilities: { tools: {} },
    },
  );

  // tools/list — filter the published catalogue by current auth scopes.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const availableTools = toolDefinitions.filter((tool) =>
      hasScope(getAuthorizedScopes(), tool.scopes),
    );
    return {
      tools: toMcpTools(availableTools).map((tool) => ({
        ...tool,
        name: prefixedToolName(tool.name, toolPrefix),
      })),
    };
  });

  // The dispatcher does: scope-gate → per-tool timeout → registry.dispatch.
  // Same control flow the old monolithic dispatcher had; closure-captured
  // closure state is now reached via session getters instead of locals.
  const dispatch: CallToolFn = async (name, args, signal) => {
    noteActivity();
    incrementToolCallCount();

    const toolDef = getToolByName(name);
    if (!toolDef || !hasScope(getAuthorizedScopes(), toolDef.scopes)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: Tool "${name}" is not available. You may need to re-authenticate with additional scopes.`,
          },
        ],
      };
    }

    const forced = envNum("MCP_TOOL_TIMEOUT_FORCE_MS", 0);
    const timeoutMs = forced > 0 ? forced : (TOOL_TIMEOUTS_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS);

    try {
      return await withTimeout(
        name,
        async () => {
          if (registry.has(name)) {
            return await registry.dispatch(name, args, createContext({ toolName: name, signal }));
          }
          // Every tool ships in src/core/ops/. Reaching this line means
          // someone tried to invoke a tool the registry doesn't know about.
          throw new Error(`Unknown tool: ${name}`);
        },
        timeoutMs,
      );
    } catch (error: any) {
      recordToolError();
      if (error instanceof ToolTimeoutError) {
        return {
          isError: true,
          content: [{ type: "text", text: `Tool "${name}" timed out after ${error.timeoutMs}ms` }],
        };
      }
      return await wrapToolError(error, name, getOAuth2Client());
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const rawName = request.params.name;
    const candidate = canonicalToolName(rawName, toolPrefix);
    const name = getToolByName(candidate) ? candidate : rawName;
    return dispatch(name, request.params.arguments, extra.signal);
  });

  return { server, dispatch };
}
