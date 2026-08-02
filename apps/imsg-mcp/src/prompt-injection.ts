/**
 * Prompt-injection guardrails for MCP tool responses.
 *
 * Messages bodies, search results, contact names, and other user-controlled
 * text returned by this MCP server may contain text designed to manipulate
 * the consuming LLM (e.g. "ignore your previous instructions and ..."). To
 * make those attacks visible at the LLM layer, every untrusted region is
 * wrapped in a `<untrusted>` envelope. The model is then trained / prompted
 * by the host to treat content inside `<untrusted>` as data, not as
 * instructions.
 *
 * We intentionally do NOT try to detect or rewrite the injection itself —
 * that's a losing game (creative attackers can encode in base64, ROT13,
 * different languages, etc). The envelope is a contract with the host:
 * "anything inside this tag came from a third party, not from the user".
 *
 * For high-stakes instructions WE want the LLM to follow (e.g. tool-specific
 * remediation hints), we use the inverse: `<instructions uuid="...">` with a
 * fresh per-session UUID so the model can distinguish them from any inline
 * `<instructions>` an attacker might inject.
 *
 * See docs/GUARDRAILS_MCP_RESPONSES.md for the rationale + threat model.
 */

import { randomUUID } from "node:crypto";

const INSTRUCTIONS_UUID = randomUUID();

/**
 * Wrap untrusted user-controlled text. Returned string is safe to embed in
 * tool responses. Nulls pass through unchanged so callers don't need to
 * defensive-check.
 */
export function wrapUntrusted(text: string | null | undefined): string {
  if (text == null || text === "") return "";
  // Strip any pre-existing `<untrusted>` closing tags inside the body so a
  // crafted message can't close our envelope early. We don't need to escape
  // every angle bracket — just neutralize the specific tags we use.
  const neutralized = text
    .replace(/<\/untrusted>/gi, "&lt;/untrusted&gt;")
    .replace(new RegExp(`<\\/instructions uuid="${INSTRUCTIONS_UUID}">`, "gi"), "")
    .replace(/<\/instructions>/gi, "&lt;/instructions&gt;");
  return `<untrusted>${neutralized}</untrusted>`;
}

/**
 * Wrap trusted server-side instructions for the LLM. The UUID is generated
 * once per process so an attacker who embeds `<instructions uuid="...">` in
 * a message body can't fake instructions — they'd have to guess our UUID.
 */
export function wrapInstructions(instructions: string): string {
  return `<instructions uuid="${INSTRUCTIONS_UUID}">${instructions}</instructions>`;
}

/**
 * Wrap a tool error with optional remediation hint. The error message is
 * itself trusted (we wrote it), but any embedded user-text in the hint
 * should already be sanitized by the caller.
 */
export function wrapToolError(tool: string, message: string, hint?: string): string {
  const head = `Tool '${tool}' failed: ${message}`;
  if (!hint) return wrapInstructions(head);
  return wrapInstructions(`${head}\n\nRemediation: ${hint}`);
}

/** Exposed for tests + diagnostics. Not for use in normal code paths. */
export function _instructionsUuidForTests(): string {
  return INSTRUCTIONS_UUID;
}
