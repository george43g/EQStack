/**
 * Client-side binding of the command specs: handlers that proxy mutations to
 * the localhost admin API (the serve process stays the single writer — INV-9)
 * and serve reads from a read-only sqlite open. Consumed by the MCP-stdio
 * adapter, the CLI, and the console REPL.
 *
 * Every handler result passes through `redactValue` (INV-11) and third-party
 * speech through sanitize + wrapUntrusted before it leaves the process.
 */

import type { AnyToolDefinition, ToolRegistry } from "@george43g/mcp-kit";
import { makeRegistry, sanitizeContent, wrapUntrusted } from "@george43g/mcp-kit";
import { redactValue } from "@george43g/robustness";
import type { z } from "zod";
import type { AdminClient } from "../client/admin-client.js";
import type { CallEvent, Utterance } from "../domain/types.js";
import type { SqliteStore } from "../stores/sqlite-store.js";
import type { CommandSpec } from "./specs.js";
import {
  deleteRecording,
  endCall,
  getCall,
  getCallEvents,
  getRecordingMetadata,
  getTranscript,
  listCalls,
  placeCall,
  playDisclosure,
  sayOnCall,
  searchCalls,
  setRecording,
} from "./specs.js";

export interface CommandDeps {
  admin: AdminClient;
  /** Open the read-only store, or null when no state DB exists yet. */
  openReadStore: () => SqliteStore | null;
}

/** Third-party speech exits here: strip control chars, mark callee text untrusted. */
export function cleanUtterance(u: Utterance): Utterance {
  const text = sanitizeContent(u.text);
  return { ...u, text: u.role === "user" ? wrapUntrusted(text) : text };
}

export function cleanEvent(e: CallEvent): CallEvent {
  return typeof e.data.text === "string"
    ? { ...e, data: { ...e.data, text: wrapUntrusted(sanitizeContent(e.data.text)) } }
    : e;
}

function bind<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  spec: CommandSpec<I, O>,
  handler: (input: z.infer<I>, signal?: AbortSignal) => Promise<z.infer<O>>,
): AnyToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    annotations: spec.annotations,
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    // INV-11: redaction on everything that leaves the process.
    handler: async (input, signal) => redactValue(await handler(input, signal)) as z.infer<O>,
  };
}

export function buildClientDefinitions(deps: CommandDeps): AnyToolDefinition[] {
  const { admin } = deps;

  const withReadStore = <T>(fn: (store: SqliteStore) => T): T => {
    const store = deps.openReadStore();
    if (!store) {
      throw new Error("no call history yet (state database does not exist — run tel serve first)");
    }
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  return [
    bind(placeCall, async (input) => admin.placeCall(input)),
    bind(endCall, async ({ callId, reason }) => {
      await admin.endCall(callId, reason);
      return { ok: true as const };
    }),
    bind(playDisclosure, async ({ callId }) => {
      await admin.playDisclosure(callId);
      return { ok: true as const };
    }),
    bind(sayOnCall, async ({ callId, text }) => {
      await admin.say(callId, text);
      return { ok: true as const, spokenChars: text.length };
    }),
    bind(setRecording, async ({ callId, enabled }) => {
      await admin.setRecording(callId, enabled);
      return { ok: true as const, enabled };
    }),
    bind(listCalls, async ({ limit, beforeMs }) => ({
      calls: withReadStore((s) =>
        s.listCalls({ ...(limit ? { limit } : {}), ...(beforeMs ? { beforeMs } : {}) }),
      ),
    })),
    bind(getCall, async ({ callId }) =>
      withReadStore((s) => {
        const call = s.getCall(callId);
        if (!call) throw new Error(`unknown call: ${callId}`);
        return {
          call,
          timings: s.getTimings(callId),
          recordings: s.getRecordingsForCall(callId),
        };
      }),
    ),
    bind(getCallEvents, async ({ callId, afterSeq, limit, waitMs }) => {
      const raw = waitMs
        ? (await admin.getEvents(callId, afterSeq ?? 0, limit ?? 200, waitMs)).events
        : withReadStore((s) => s.getEvents(callId, afterSeq ?? 0, limit ?? 200));
      const events = raw.map(cleanEvent);
      const last = events[events.length - 1];
      return { events, nextCursor: last ? last.seq : (afterSeq ?? 0) };
    }),
    bind(getTranscript, async ({ callId }) => ({
      transcript: withReadStore((s) => s.getTranscript(callId)).map(cleanUtterance),
    })),
    bind(searchCalls, async ({ query, limit }) =>
      withReadStore((s) => ({
        calls: s.searchCalls(query, limit ?? 20),
        utterances: s.searchTranscripts(query, limit ?? 20).map(cleanUtterance),
      })),
    ),
    bind(getRecordingMetadata, async ({ callId }) => ({
      recordings: withReadStore((s) => s.getRecordingsForCall(callId)),
    })),
    bind(deleteRecording, async ({ recordingSid, scope, confirm }) =>
      admin.deleteRecording(recordingSid, scope, confirm),
    ),
  ];
}

export function buildClientRegistry(deps: CommandDeps): ToolRegistry {
  return makeRegistry(buildClientDefinitions(deps));
}
