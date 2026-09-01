/**
 * ConversationRelay WebSocket frames — parsed strictly at the boundary
 * (unknown/malformed frames are surfaced as such, never guessed at).
 * https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
 */
import { z } from "zod";

export const SetupMessageSchema = z
  .object({
    type: z.literal("setup"),
    sessionId: z.string(),
    callSid: z.string(),
  })
  .passthrough();

export const PromptMessageSchema = z
  .object({
    type: z.literal("prompt"),
    voicePrompt: z.string(),
    last: z.boolean().default(true),
    lang: z.string().optional(),
  })
  .passthrough();

export const InterruptMessageSchema = z
  .object({
    type: z.literal("interrupt"),
    utteranceUntilInterrupt: z.string().default(""),
    durationUntilInterruptMs: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

export const DtmfMessageSchema = z
  .object({
    type: z.literal("dtmf"),
    digit: z.string(),
  })
  .passthrough();

export const ErrorMessageSchema = z
  .object({
    type: z.literal("error"),
    description: z.string().default(""),
  })
  .passthrough();

export const RelayInboundSchema = z.discriminatedUnion("type", [
  SetupMessageSchema,
  PromptMessageSchema,
  InterruptMessageSchema,
  DtmfMessageSchema,
  ErrorMessageSchema,
]);
export type RelayInbound = z.infer<typeof RelayInboundSchema>;

export type ParseResult =
  | { ok: true; message: RelayInbound }
  | { ok: false; error: string; raw: string };

export function parseRelayMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not JSON", raw: raw.slice(0, 200) };
  }
  const parsed = RelayInboundSchema.safeParse(json);
  if (!parsed.success) {
    const type =
      typeof json === "object" && json !== null && "type" in json
        ? String((json as { type: unknown }).type)
        : "(none)";
    return {
      ok: false,
      error: `unsupported or malformed frame type=${type}`,
      raw: raw.slice(0, 200),
    };
  }
  return { ok: true, message: parsed.data };
}

/** Outbound frames we send to ConversationRelay. */
export function textFrame(token: string, last: boolean): string {
  return JSON.stringify({ type: "text", token, last });
}

export function endFrame(handoffData?: Record<string, unknown>): string {
  return JSON.stringify(
    handoffData ? { type: "end", handoffData: JSON.stringify(handoffData) } : { type: "end" },
  );
}
