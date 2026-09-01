/**
 * telephony-mcp stdio MCP adapter — a thin veneer over the command registry
 * (Phase B step 6): look up → validate → dispatch. Tool schemas, handlers and
 * INV-11 redaction all live in src/commands/; this file only wires the
 * registry to the low-level SDK Server and re-exposes the tel:// resources.
 *
 * Mutations proxy the localhost admin API (the serve process is the single
 * writer — INV-9); history reads open the sqlite store read-only, so a second
 * MCP client can browse transcripts while a call is live. Logging is
 * stderr-only — stdout belongs to the transport.
 *
 * The kit dispatcher adds what the registerTool era lacked (ledger row L-4):
 * per-tool timeout, perf span in `_meta`, AbortSignal pass-through, and
 * noteActivity() on every call so a long-polling host stays visible to the
 * idle watchdog (Phase A Q-A3).
 */
import { existsSync } from "node:fs";
import {
  buildDispatcher,
  buildResourcesHandler,
  type ResourcesProvider,
  startStdio,
} from "@george43g/mcp-kit";
import { redactValue } from "@george43g/robustness";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AdminClient } from "../client/admin-client.js";
import { buildClientRegistry, cleanEvent, cleanUtterance } from "../commands/bind-client.js";
import type { Config } from "../config/schema.js";
import { log } from "../log.js";
import { dbPath } from "../paths.js";
import { SqliteStore } from "../stores/sqlite-store.js";
import { VERSION } from "../version.js";

export interface McpDeps {
  cfg: Config;
  admin: AdminClient;
  /** Factory so tests can inject a store; defaults to read-only sqlite. */
  openReadStore?: () => SqliteStore | null;
}

function defaultOpenReadStore(): SqliteStore | null {
  const path = dbPath();
  if (!existsSync(path)) return null;
  return new SqliteStore(path, { readonly: true });
}

/** The three per-call views a tel:// URI can address. */
const READ_URI = /^tel:\/\/calls\/([^/]+?)(?:\/(transcript|events))?$/;

export function buildMcpServer(deps: McpDeps): Server {
  const { cfg, admin } = deps;
  const openReadStore = deps.openReadStore ?? defaultOpenReadStore;

  const withReadStore = <T>(fn: (store: SqliteStore) => T): T => {
    const store = openReadStore();
    if (!store) {
      throw new Error("no call history yet (state database does not exist — run tel serve first)");
    }
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  const registry = buildClientRegistry({ admin, openReadStore });
  const dispatch = buildDispatcher({
    registry,
    engineLabel: () => "ts",
    onError: (tool) => log("warn", "tool_error", { tool }),
  });

  const provider: ResourcesProvider = {
    list: () => {
      // No history DB yet → an empty listing, not a listing error.
      try {
        return withReadStore((s) =>
          s.listCalls({ limit: 50 }).map((c) => ({
            uri: `tel://calls/${c.id}`,
            name: `call ${c.id} (${c.recipientAlias}, ${c.status})`,
            mimeType: "application/json",
          })),
        );
      } catch {
        return [];
      }
    },
    listTemplates: () => [
      {
        uriTemplate: "tel://calls/{callId}",
        name: "call",
        description: "Call record as JSON",
        mimeType: "application/json",
      },
      {
        uriTemplate: "tel://calls/{callId}/transcript",
        name: "transcript",
        description: "Finalized utterances as JSON",
        mimeType: "application/json",
      },
      {
        uriTemplate: "tel://calls/{callId}/events",
        name: "events",
        description: "Per-call event log as JSON",
        mimeType: "application/json",
      },
    ],
    read: (uri) => {
      const match = READ_URI.exec(uri);
      if (!match) throw new Error(`unknown resource URI: ${uri}`);
      const [, callId = "", view] = match;
      const body =
        view === "transcript"
          ? withReadStore((s) => s.getTranscript(callId)).map(cleanUtterance)
          : view === "events"
            ? withReadStore((s) => s.getEvents(callId, 0, 500)).map(cleanEvent)
            : withReadStore((s) => s.getCall(callId));
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(redactValue(body), null, 2),
      };
    },
  };
  const resources = buildResourcesHandler({ provider });

  const server = new Server(
    { name: "telephony-mcp", version: VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.toMcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    dispatch(request.params.name, request.params.arguments, extra.signal),
  );
  server.setRequestHandler(ListResourcesRequestSchema, resources.onList);
  server.setRequestHandler(ListResourceTemplatesRequestSchema, resources.onListTemplates);
  server.setRequestHandler(ReadResourceRequestSchema, (request) => resources.onRead(request));

  void cfg; // reserved for future per-tool config gating
  return server;
}

/** stdio entry point: kit lifecycle (shutdown, stdin EOF, orphan watch, watchdog — L-5). */
export async function runStdioMcp(deps: McpDeps): Promise<void> {
  await startStdio({ server: buildMcpServer(deps), entrypoint: "tel-mcp" });
}
