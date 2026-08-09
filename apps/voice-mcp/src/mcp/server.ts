/**
 * voice-mcp stdio MCP server.
 *
 * Mutations proxy the localhost admin API (the serve process is the single
 * writer); history reads open the sqlite store read-only, so a second MCP
 * client can browse transcripts while a call is live. Logging is
 * stderr-only — stdout belongs to the transport.
 *
 * Safety surface: two-stage prepare→start with explicit confirmation;
 * voice_start_call is annotated paid/destructive/non-idempotent/open-world
 * and retries return the already-created call; recordings are metadata-only
 * over MCP (no audio bytes, nothing autoplays); deletion needs an explicit
 * scope + confirmation.
 */
import { existsSync } from "node:fs";
import { redactValue } from "@george43g/robustness";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdminClient } from "../client/admin-client.js";
import type { Config } from "../config/schema.js";
import { VERSION } from "../gateway/admin-server.js";
import { dbPath } from "../paths.js";
import { SqliteStore } from "../stores/sqlite-store.js";

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

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(redactValue(value), null, 2) }],
  };
}

function errorContent(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
    isError: true,
  };
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const { cfg, admin } = deps;
  const openReadStore = deps.openReadStore ?? defaultOpenReadStore;

  const withReadStore = <T>(fn: (store: SqliteStore) => T): T => {
    const store = openReadStore();
    if (!store) {
      throw new Error(
        "no call history yet (state database does not exist — run voice-mcp serve first)",
      );
    }
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  const server = new McpServer({ name: "voice-mcp", version: VERSION });

  // ── Stage 1: prepare ─────────────────────────────────────────────────────
  server.registerTool(
    "voice_prepare_call",
    {
      title: "Prepare a phone call (stage 1 of 2)",
      description:
        "Resolve an allowlisted recipient alias and create an EXPIRING call request. Returns the request id plus what would happen (number suffix, purpose, profile, max duration, recording state). Nothing is dialed. Pass the request id to voice_start_call with explicit confirmation to actually place the call.",
      inputSchema: {
        recipient: z
          .string()
          .describe("Allowlisted recipient alias from config (not a phone number)"),
        objective: z
          .string()
          .min(1)
          .describe("What the call should achieve — becomes the LLM's objective"),
        context: z.string().optional().describe("Optional extra context from the initiating agent"),
        profile: z.string().optional().describe("Call profile name (default: 'default')"),
        record: z
          .boolean()
          .optional()
          .describe("Request recording on/off (subject to the recipient's recording policy)"),
        mode: z
          .enum(["llm", "direct"])
          .optional()
          .describe(
            "Conversation driver. 'llm' (default): the configured LLM conducts the call from the objective. 'direct': YOU (the MCP host) are the conversational brain — after the call is answered, loop: voice_get_events { callId, afterSeq, waitMs: 25000 } until a turn.user event arrives, read the utterance with voice_get_transcript, then reply with voice_say. Keep replies short; a phone line is waiting.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { request } = await admin.prepare(input);
        return jsonContent({
          request,
          nextStep:
            "Confirm these details with the user, then call voice_start_call { requestId, confirm: true }. This will place a REAL, PAID phone call.",
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ── Stage 2: start ───────────────────────────────────────────────────────
  server.registerTool(
    "voice_start_call",
    {
      title: "Place the phone call (stage 2 of 2 — PAID, real-world)",
      description:
        "Dial the prepared call request. Requires the request id from voice_prepare_call and confirm: true. This places a REAL PAID phone call to a REAL person. Retrying with the same request id returns the already-created call instead of dialing twice.",
      inputSchema: {
        requestId: z.string().describe("Request id returned by voice_prepare_call"),
        confirm: z.literal(true).describe("Must be exactly true — explicit confirmation to dial"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ requestId, confirm }) => {
      try {
        const { call } = await admin.start(requestId, confirm);
        return jsonContent({ call });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ── Live control ─────────────────────────────────────────────────────────
  server.registerTool(
    "voice_end_call",
    {
      title: "End a live call",
      description: "Hang up a live call immediately.",
      inputSchema: {
        callId: z.string(),
        reason: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ callId, reason }) => {
      try {
        await admin.endCall(callId, reason);
        return jsonContent({ ok: true });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "voice_play_disclosure",
    {
      title: "Speak the recording disclosure",
      description:
        "Speak the configured recording-disclosure line into the live call. NEVER invoked automatically — this is the manual step before enabling recording for a 'manual'-policy recipient.",
      inputSchema: { callId: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ callId }) => {
      try {
        await admin.playDisclosure(callId);
        return jsonContent({ ok: true });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "voice_say",
    {
      title: "Speak text into a live call",
      description:
        "Speak the given text verbatim (TTS) into the live call. This is the reply path for 'direct'-mode calls: wait for the callee's next utterance (voice_get_events with waitMs), read it (voice_get_transcript), then answer with this tool. Keep replies short and conversational — they are spoken aloud on a real phone line. Refused when the call has no live session (not answered yet, or ended).",
      inputSchema: {
        callId: z.string(),
        text: z.string().min(1).max(2000).describe("Text to speak, verbatim"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ callId, text }) => {
      try {
        await admin.say(callId, text);
        return jsonContent({ ok: true, spokenChars: text.length });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "voice_set_recording",
    {
      title: "Toggle call recording",
      description:
        "Enable or disable recording on a live call. Enabling is refused for 'never'-policy recipients; for 'manual' recipients, play the disclosure first (voice_play_disclosure) — this tool does not do it for you.",
      inputSchema: { callId: z.string(), enabled: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ callId, enabled }) => {
      try {
        await admin.setRecording(callId, enabled);
        return jsonContent({ ok: true, enabled });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ── Observation (read-only, direct DB) ───────────────────────────────────
  server.registerTool(
    "voice_list_calls",
    {
      title: "List calls",
      description:
        "List calls, newest first. Paginate with beforeMs (createdAtMs of the last row).",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        beforeMs: z.number().int().positive().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, beforeMs }) => {
      try {
        return jsonContent({
          calls: withReadStore((s) =>
            s.listCalls({ ...(limit ? { limit } : {}), ...(beforeMs ? { beforeMs } : {}) }),
          ),
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "voice_get_call",
    {
      title: "Get one call",
      description: "Fetch a call record (status, recording state, timings included).",
      inputSchema: { callId: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ callId }) => {
      try {
        return jsonContent(
          withReadStore((s) => {
            const call = s.getCall(callId);
            if (!call) throw new Error(`unknown call: ${callId}`);
            return {
              call,
              timings: s.getTimings(callId),
              recordings: s.getRecordingsForCall(callId),
            };
          }),
        );
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "voice_get_events",
    {
      title: "Get call events",
      description:
        "Cursor-paginated per-call event feed (afterSeq → next page). With waitMs, long-polls: if no events exist past afterSeq yet, waits up to waitMs for the next one — use ~25000 in direct-mode conversations to wait for the callee's next utterance (turn.user) without busy-polling.",
      inputSchema: {
        callId: z.string(),
        afterSeq: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(55_000)
          .optional()
          .describe("Long-poll timeout in ms (requires the gateway to be running)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ callId, afterSeq, limit, waitMs }) => {
      try {
        const events = waitMs
          ? (await admin.getEvents(callId, afterSeq ?? 0, limit ?? 200, waitMs)).events
          : withReadStore((s) => s.getEvents(callId, afterSeq ?? 0, limit ?? 200));
        const last = events[events.length - 1];
        return jsonContent({ events, nextCursor: last ? last.seq : (afterSeq ?? 0) });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "voice_get_transcript",
    {
      title: "Get call transcript",
      description: "Finalized utterances for a call, in order, with interruption flags.",
      inputSchema: { callId: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ callId }) => {
      try {
        return jsonContent({ transcript: withReadStore((s) => s.getTranscript(callId)) });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "voice_search_calls",
    {
      title: "Search calls and transcripts",
      description: "Full-text search over transcripts and call metadata (FTS5 syntax supported).",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      try {
        return jsonContent(
          withReadStore((s) => ({
            calls: s.searchCalls(query, limit ?? 20),
            utterances: s.searchTranscripts(query, limit ?? 20),
          })),
        );
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "voice_get_recording_metadata",
    {
      title: "Get recording metadata",
      description:
        "Recording metadata for a call (ids, duration, size, deletion state). Audio bytes are NEVER returned over MCP — use the voice-mcp CLI to play or export locally.",
      inputSchema: { callId: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ callId }) => {
      try {
        return jsonContent({ recordings: withReadStore((s) => s.getRecordingsForCall(callId)) });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ── Destruction ──────────────────────────────────────────────────────────
  server.registerTool(
    "voice_delete_recording",
    {
      title: "Delete a recording (destructive)",
      description:
        "Delete a recording locally, at the provider, or both. Requires an explicit scope and confirm: true. Provider deletion is irreversible.",
      inputSchema: {
        recordingSid: z.string(),
        scope: z.enum(["local", "provider", "both"]).describe("Where to delete"),
        confirm: z.literal(true).describe("Must be exactly true"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ recordingSid, scope, confirm }) => {
      try {
        return jsonContent(await admin.deleteRecording(recordingSid, scope, confirm));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  // ── Resources ────────────────────────────────────────────────────────────
  server.registerResource(
    "call",
    new ResourceTemplate("voice://calls/{callId}", {
      list: async () => ({
        resources: withReadStoreSafe((s) =>
          s.listCalls({ limit: 50 }).map((c) => ({
            uri: `voice://calls/${c.id}`,
            name: `call ${c.id} (${c.recipientAlias}, ${c.status})`,
            mimeType: "application/json",
          })),
        ),
      }),
    }),
    { title: "Call record", description: "Call record as JSON" },
    async (uri, { callId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            redactValue(withReadStore((s) => s.getCall(String(callId)))),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "transcript",
    new ResourceTemplate("voice://calls/{callId}/transcript", { list: undefined }),
    { title: "Call transcript", description: "Finalized utterances as JSON" },
    async (uri, { callId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            redactValue(withReadStore((s) => s.getTranscript(String(callId)))),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "events",
    new ResourceTemplate("voice://calls/{callId}/events", { list: undefined }),
    { title: "Call events", description: "Per-call event log as JSON" },
    async (uri, { callId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            redactValue(withReadStore((s) => s.getEvents(String(callId), 0, 500))),
            null,
            2,
          ),
        },
      ],
    }),
  );

  function withReadStoreSafe<T>(fn: (store: SqliteStore) => T[]): T[] {
    try {
      return withReadStore(fn);
    } catch {
      return [];
    }
  }

  void cfg; // reserved for future per-tool config gating
  return server;
}
