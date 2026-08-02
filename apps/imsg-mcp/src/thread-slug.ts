/**
 * Pure slug generation logic for conversation threads.
 * No side effects; takes data in, returns slug string.
 */

import { createHash } from "node:crypto";

/** Sanitize a name into a slug-safe part: lowercase, spaces to hyphens, strip non-alphanumeric. */
export function sanitizeSlugPart(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** 4-char hex hash derived from a string (deterministic). */
export function shortHash(input: string): string {
  return createHash("md5").update(input).digest("hex").slice(0, 4);
}

/** Abbreviate service name: "iMessage" -> "imsg", "SMS" -> "sms". */
export function serviceAbbrev(service: string): string {
  const lower = service.toLowerCase();
  if (lower === "imessage") return "imsg";
  if (lower === "sms") return "sms";
  return sanitizeSlugPart(lower) || "msg";
}

/** True if a chat_identifier looks like a group chat (starts with "chat"). */
export function isGroupChatIdentifier(chatIdentifier: string): boolean {
  return chatIdentifier.startsWith("chat");
}

/** True if a chat guid indicates a group chat (contains ";+;"). */
export function isGroupGuid(guid: string): boolean {
  return guid.includes(";+;");
}

/**
 * True if `value` matches the `name~service~hash` slug shape generated
 * above. Used by the CLI to decide whether `imsg send <target>` should
 * treat the target as a slug or as a recipient handle.
 *
 * Specifically distinguishes slugs from:
 *   - emails — `~` is legal in the local-part (`user~beta@example.com`),
 *     but slugs never have `@`
 *   - phone numbers — never have `~`
 *   - contact names — typed names don't use `~`
 */
export function looksLikeThreadSlug(value: string | undefined): boolean {
  if (!value) return false;
  if (value.includes("@")) return false;
  const parts = value.split("~");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export interface SlugInput {
  chatIdentifier: string;
  guid: string;
  displayName: string | null;
  serviceName: string | null;
  /** Resolved contact name for 1-on-1 chats (from ContactsDB). */
  resolvedContactName: string | null;
  /**
   * Stable identity key the hash is derived from, so every chat leg of one
   * identity yields the SAME slug. For a 1-on-1 with a resolved contact this is
   * `contact:<contactId>` (covers all the contact's numbers + emails across SMS
   * and iMessage); otherwise the normalized handle; for groups, the chat guid.
   * Falls back to `guid` when not provided.
   */
  identityKey?: string;
}

/**
 * Generate a thread slug from chat metadata.
 *
 * Format: {sanitized-name}~{service}~{short-hash}
 *
 * The hash is derived from `identityKey` (not the per-chat guid) so a contact
 * whose conversation is split across a phone chat and an email chat — and across
 * SMS + iMessage — collapses to ONE stable slug.
 *
 * Examples:
 *   1-on-1 with contact: alice~imsg~a3f2
 *   1-on-1 no contact:   61451082095~sms~b7c1
 *   Named group:         weekend-crew~imsg~d4e5
 *   Unnamed group:       group~imsg~f6a7
 */
export function generateThreadSlug(input: SlugInput): string {
  const svc = serviceAbbrev(input.serviceName || "iMessage");
  const hash = shortHash(input.identityKey ?? input.guid);
  const isGroup = isGroupGuid(input.guid) || isGroupChatIdentifier(input.chatIdentifier);

  let namePart: string;
  if (isGroup) {
    if (input.displayName && !input.displayName.startsWith("chat")) {
      namePart = sanitizeSlugPart(input.displayName);
    } else {
      namePart = "group";
    }
  } else {
    if (input.resolvedContactName) {
      namePart = sanitizeSlugPart(input.resolvedContactName);
    } else if (input.displayName && input.displayName !== input.chatIdentifier) {
      namePart = sanitizeSlugPart(input.displayName);
    } else {
      namePart = sanitizeSlugPart(input.chatIdentifier.replace(/^\+/, ""));
    }
  }

  if (!namePart) namePart = "unknown";

  return `${namePart}~${svc}~${hash}`;
}
