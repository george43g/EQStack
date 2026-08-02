/**
 * Pure formatting and validation helpers for the MCP server's tool responses.
 * Extracted from src/index.ts: no server state, no side effects beyond the
 * fs existence checks in validateExportOutputPath — everything here is
 * directly unit-testable.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { AnalyticType } from "./analytics.js";
import { renderAnalyticText } from "./analytics-render.js";
import { hasNativeModule } from "./native-bridge.js";
import { wrapUntrusted } from "./prompt-injection.js";
import { sanitizeUserText } from "./sanitize.js";
import type { Message } from "./types.js";

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Human-readable text rendering for every analytic, shared with the CLI via
 * src/analytics-render.ts so the agent (tool text) and a person (`imsg
 * analytics …`) see the same summary.
 */
export function analyticTextSummary(type: AnalyticType, data: unknown): string {
  const rendered = renderAnalyticText(type, data);
  return rendered ? `\n\n${rendered}` : "";
}

/** Format a millisecond duration as e.g. "1h 23m" or "5s". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const sec = Math.floor(ms / 1_000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

/**
 * Format a date as a relative short string ("Today 12:05 AM", "Yesterday 3:14 PM", or "2/14 9:00 AM").
 */
export function relativeDate(d: Date): string {
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return `Yesterday ${time}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/**
 * Format a message for output with display name, service, relative date, and delivery status.
 * Optional conversationLabel adds context for cross-conversation views (unread, search).
 */
export function formatMessage(msg: Message, conversationLabel?: string): string {
  const direction = msg.isFromMe ? "→" : "←";
  const dateStr = relativeDate(msg.date);
  const svcTag = msg.service === "SMS" ? " [SMS]" : "";

  let sender: string;
  if (msg.isFromMe) {
    sender = "me";
  } else if (msg.displayName && msg.displayName !== msg.handle) {
    sender = `${msg.displayName} (${msg.handle})`;
  } else {
    sender = msg.handle;
  }

  let status = "";
  if (msg.isRetracted) {
    status = " [UNSENT — sender retracted this message]";
  } else if (!msg.isFromMe && !msg.isRead) {
    status = " [UNREAD]";
  } else if (msg.isFromMe && msg.sendError) {
    status = ` [NOT DELIVERED — send failed (error ${msg.sendError})]`;
  } else if (msg.isFromMe) {
    if (msg.dateRead) {
      status = ` [Read ${msg.dateRead.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}]`;
    } else if (msg.isDelivered) {
      status = " [Delivered]";
    }
  }

  const convCtx = conversationLabel ? ` {${conversationLabel}}` : "";
  const rawText = sanitizeUserText(msg.text);
  // Wrap user-controlled message bodies in <untrusted> so a downstream LLM
  // treats prompt-injection attempts in the body as data, not instructions.
  const bodyText = rawText ? wrapUntrusted(rawText) : null;
  // Genmoji: surface Apple's authored short descriptions (server-derived
  // metadata, not user free-text) so an agent can "see" the custom emoji.
  const genmoji = (msg.attachments ?? [])
    .map((a) => a.emojiDescription)
    .filter((d): d is string => Boolean(d));
  const genmojiTag = genmoji.length ? ` [genmoji: ${genmoji.map((d) => `"${d}"`).join(", ")}]` : "";
  // Interpreted media: a voice-note transcript or image/video caption resolved
  // from a CACHED or INSTANT result (never a blocking cloud call). Like the
  // body, the transcript is user-derived content, so wrap it <untrusted>.
  const interp = msg.interpretedMedia;
  const interpText = interp?.text ? sanitizeUserText(interp.text) : null;
  let mediaTag = "";
  if (interpText) {
    const label =
      interp?.kind === "audio" ? "voice note" : interp?.kind === "video" ? "video" : "image";
    mediaTag = ` [${label}: ${wrapUntrusted(interpText)}]`;
  }
  // The placeholder is server-generated and trusted; suppress it when an
  // interpreted transcript already carries the message's content.
  const text = bodyText ?? (mediaTag ? "" : msg.isRetracted ? "(unsent)" : "(no text)");
  const body = text ? `${text}${genmojiTag}${mediaTag}` : `${genmojiTag}${mediaTag}`.trimStart();
  return `[${dateStr}] ${direction} ${sender}${svcTag}: ${body}${status}${convCtx}`;
}

export function messageToStructured(msg: Message) {
  return {
    ...msg,
    text: sanitizeUserText(msg.text),
    date: msg.date.toISOString(),
    dateRead: msg.dateRead?.toISOString() ?? null,
    dateDelivered: msg.dateDelivered?.toISOString() ?? null,
  };
}

export function toolText(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

/**
 * Format an error from the tool dispatcher into a single human-readable
 * line. Zod's `.message` is a JSON-stringified array of issues by
 * default — fine for logs, awful for agent-facing responses. We extract
 * just the first issue's path + message so the result reads like
 * `"handle: String must contain at least 1 character(s)"`.
 */
export function formatToolError(error: unknown): string {
  if (error == null) return "Unknown error";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  // Detect Zod-style "[\n  {\"code\":..." prefix.
  if (message.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(message) as Array<{ message?: string; path?: unknown[] }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const issue = parsed[0];
        const pathStr =
          Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${pathStr}${issue.message ?? "validation failed"}`;
      }
    } catch {
      // Not real JSON; fall through to the raw message.
    }
  }
  return message;
}

export function toolError(text: string, _structuredContent?: Record<string, unknown>) {
  return {
    ...toolText(text),
    isError: true,
  };
}

export function validateExportOutputPath(outputPath: string): string | null {
  if (!isAbsolute(outputPath)) {
    return "outputPath must be an absolute path.";
  }

  const parent = dirname(outputPath);
  if (!existsSync(parent)) {
    return `Parent directory does not exist: ${parent}`;
  }

  const parentStat = statSync(parent);
  if (!parentStat.isDirectory()) {
    return `Parent path is not a directory: ${parent}`;
  }

  if (existsSync(outputPath) && statSync(outputPath).isDirectory()) {
    return `outputPath points to a directory, not a file: ${outputPath}`;
  }

  return null;
}

export function engineLabel(): string {
  return hasNativeModule() ? "Rust parser + TS DB" : "TS";
}
