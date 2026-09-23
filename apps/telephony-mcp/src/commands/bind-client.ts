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
import { buildLatencyReport } from "../domain/latency-report.js";
import { eventsForMember, memberPollRefusal } from "../domain/meeting-events.js";
import type { CallEvent, Utterance } from "../domain/types.js";
import type { SqliteStore } from "../stores/sqlite-store.js";
import type { VoicePreviewService } from "../voice-preview/service.js";
import type { CommandSpec } from "./specs.js";
import {
  answerConsult,
  deleteRecording,
  endCall,
  getCall,
  getCallEvents,
  getLatencyReport,
  getRecordingMetadata,
  getTranscript,
  listCalls,
  placeCall,
  playDisclosure,
  previewVoices,
  reviewVoicePreview,
  saveVoiceProfile,
  sayOnCall,
  searchCalls,
  setRecording,
  startMeeting,
} from "./specs.js";

export interface CommandDeps {
  admin: AdminClient;
  /** Open the read-only store, or null when no state DB exists yet. */
  openReadStore: () => SqliteStore | null;
  /**
   * The voice-preview workflow, built on first use (it needs the
   * agentPlatform block and resolves the platform key by name — INV-12).
   * Absent → the three preview commands refuse with a pointer to config.
   */
  voicePreview?: () => VoicePreviewService;
}

/** Third-party speech exits here: strip control chars, mark callee text untrusted. */
export function cleanUtterance(u: Utterance): Utterance {
  const text = sanitizeContent(u.text);
  return { ...u, text: u.role === "user" ? wrapUntrusted(text) : text };
}

/**
 * Third-party text in an event is marked untrusted before it reaches a host:
 * `text` (callee speech) and `question` (a consult question, written by the
 * EL agent from what the callee said — a prompt-injection path into a
 * session that holds tools, PHASE-R § 6).
 */
export function cleanEvent(e: CallEvent): CallEvent {
  let data = e.data;
  for (const key of ["text", "question"] as const) {
    const v = data[key];
    if (typeof v === "string") data = { ...data, [key]: wrapUntrusted(sanitizeContent(v)) };
  }
  return data === e.data ? e : { ...e, data };
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

  const preview = (): VoicePreviewService => {
    if (!deps.voicePreview) {
      throw new Error(
        "voice preview needs an agentPlatform block in config (the ElevenLabs account the audition runs on)",
      );
    }
    return deps.voicePreview();
  };

  return [
    bind(placeCall, async (input) => admin.placeCall(input)),
    bind(startMeeting, async (input) => admin.startMeeting(input)),
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
    bind(getCallEvents, async ({ callId, afterSeq, limit, waitMs, as }) => {
      let page: { events: CallEvent[]; nextCursor?: number | undefined };
      if (waitMs) {
        // serve filters (and marks this member listening) for a long-poll.
        page = await admin.getEvents(callId, afterSeq ?? 0, limit ?? 200, waitMs, as);
      } else {
        // A read without waitMs never counts as listening (D-98), so it stays
        // off serve — but `as` still filters it, with the same refusals.
        page = withReadStore((s) => {
          const raw = s.getEvents(callId, afterSeq ?? 0, limit ?? 200);
          if (as === undefined) return { events: raw };
          const roster = s.listMeetingMembers(callId).map((m) => m.member);
          const refusal = memberPollRefusal(roster.length > 0 ? roster : null, as);
          if (refusal) throw new Error(refusal);
          return { events: eventsForMember(raw, as), nextCursor: raw.at(-1)?.seq ?? afterSeq ?? 0 };
        });
      }
      const events = page.events.map(cleanEvent);
      const last = events[events.length - 1];
      return {
        events,
        nextCursor: page.nextCursor ?? (last ? last.seq : (afterSeq ?? 0)),
      };
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
    bind(getLatencyReport, async ({ lastCalls, callId }) =>
      withReadStore((s) => {
        const calls = callId
          ? [s.getCall(callId)].flatMap((c) => (c ? [c] : []))
          : s.listCalls({ limit: lastCalls ?? 50 });
        const rows = calls.flatMap((c) => {
          const mode = s.getCallRequest(c.requestId)?.mode ?? "byo-model";
          return s.getTimings(c.id).map((timing) => ({ timing, mode }));
        });
        return buildLatencyReport(
          rows,
          calls.length,
          calls.flatMap((c) => s.listConsultQuestions(c.id)),
        );
      }),
    ),
    bind(getRecordingMetadata, async ({ callId }) => ({
      recordings: withReadStore((s) => s.getRecordingsForCall(callId)),
    })),
    bind(deleteRecording, async ({ recordingSid, scope, confirm }) =>
      admin.deleteRecording(recordingSid, scope, confirm),
    ),
    bind(answerConsult, async ({ callId, questionId, answer }) =>
      admin.answerConsult(callId, questionId, answer),
    ),
    bind(previewVoices, async ({ candidates, reset, applyFrom }) =>
      preview().preview({
        ...(candidates !== undefined ? { candidates } : {}),
        ...(reset !== undefined ? { reset } : {}),
        ...(applyFrom !== undefined ? { applyFrom } : {}),
      }),
    ),
    bind(reviewVoicePreview, async ({ conversation }) => preview().review(conversation)),
    bind(saveVoiceProfile, async (input) =>
      preview().save({
        ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.base !== undefined ? { base: input.base } : {}),
        ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}),
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      }),
    ),
  ];
}

export function buildClientRegistry(deps: CommandDeps): ToolRegistry {
  return makeRegistry(buildClientDefinitions(deps));
}
