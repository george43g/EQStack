/**
 * Coverage for the pure thread-slug generator. Slugs are used as the
 * stable, agent-facing handle for every conversation — a regression
 * here ripples through `list_conversations`, `send_message` (via
 * `threadSlug`), and every downstream caller that stores or compares
 * slugs.
 */

import { describe, expect, it } from "vitest";
import {
  generateThreadSlug,
  isGroupChatIdentifier,
  isGroupGuid,
  looksLikeThreadSlug,
  sanitizeSlugPart,
  serviceAbbrev,
  shortHash,
} from "../src/thread-slug.js";

describe("sanitizeSlugPart", () => {
  it("lowercases, hyphenates spaces, strips non-alphanumeric", () => {
    expect(sanitizeSlugPart("Alice Smith")).toBe("alice-smith");
    expect(sanitizeSlugPart("Weekend Crew!!")).toBe("weekend-crew");
    expect(sanitizeSlugPart("you & me")).toBe("you-me");
  });

  it("strips smart apostrophes (curly quotes from macOS)", () => {
    expect(sanitizeSlugPart("Brian’s Group")).toBe("brians-group");
    expect(sanitizeSlugPart("dont")).toBe("dont");
  });

  it("collapses runs of separators to a single hyphen", () => {
    expect(sanitizeSlugPart("hello___world")).toBe("hello-world");
    expect(sanitizeSlugPart("a  b\tc")).toBe("a-b-c");
  });

  it("trims leading/trailing hyphens", () => {
    expect(sanitizeSlugPart("-hello-")).toBe("hello");
    expect(sanitizeSlugPart("!!@#$ hello !!")).toBe("hello");
  });

  it("returns empty string when nothing survives sanitisation", () => {
    expect(sanitizeSlugPart("!@#$%")).toBe("");
    expect(sanitizeSlugPart("")).toBe("");
  });
});

describe("shortHash", () => {
  it("returns a 4-char hex string", () => {
    expect(shortHash("anything")).toMatch(/^[0-9a-f]{4}$/);
  });

  it("is deterministic", () => {
    expect(shortHash("foo")).toBe(shortHash("foo"));
  });

  it("differs for different inputs", () => {
    expect(shortHash("foo")).not.toBe(shortHash("bar"));
  });
});

describe("serviceAbbrev", () => {
  it("normalizes known services", () => {
    expect(serviceAbbrev("iMessage")).toBe("imsg");
    expect(serviceAbbrev("IMESSAGE")).toBe("imsg");
    expect(serviceAbbrev("SMS")).toBe("sms");
    expect(serviceAbbrev("sms")).toBe("sms");
  });

  it("falls back to sanitised input for unknown services", () => {
    expect(serviceAbbrev("RCS")).toBe("rcs");
    expect(serviceAbbrev("WhatsApp Bridge")).toBe("whatsapp-bridge");
  });

  it("returns 'msg' when nothing survives sanitisation", () => {
    expect(serviceAbbrev("!!")).toBe("msg");
  });
});

describe("isGroupChatIdentifier / isGroupGuid", () => {
  it("detects chat-prefixed identifiers as groups", () => {
    expect(isGroupChatIdentifier("chat123456")).toBe(true);
    expect(isGroupChatIdentifier("chat770107254652978061")).toBe(true);
  });

  it("rejects phone / email as group identifiers", () => {
    expect(isGroupChatIdentifier("+61401990797")).toBe(false);
    expect(isGroupChatIdentifier("alice@icloud.com")).toBe(false);
  });

  it("detects ';+;' guids as groups", () => {
    expect(isGroupGuid("iMessage;+;chat123456")).toBe(true);
  });

  it("rejects ';-;' guids as 1-on-1", () => {
    expect(isGroupGuid("iMessage;-;+61401990797")).toBe(false);
  });
});

describe("looksLikeThreadSlug", () => {
  it("accepts the canonical name~service~hash shape", () => {
    expect(looksLikeThreadSlug("alice~imsg~a3f2")).toBe(true);
    expect(looksLikeThreadSlug("weekend-crew~imsg~d4e5")).toBe(true);
    expect(looksLikeThreadSlug("61401990797~sms~b7c1")).toBe(true);
  });

  it("rejects phone numbers", () => {
    expect(looksLikeThreadSlug("+61401990797")).toBe(false);
    expect(looksLikeThreadSlug("0401 990 797")).toBe(false);
    expect(looksLikeThreadSlug("415-555-0100")).toBe(false);
  });

  it("rejects emails (even ones with ~ in local-part)", () => {
    // Pre-fix bug: `value.includes("~")` would route `user~beta@example.com`
    // as a thread slug.
    expect(looksLikeThreadSlug("alice@icloud.com")).toBe(false);
    expect(looksLikeThreadSlug("user~beta@example.com")).toBe(false);
    expect(looksLikeThreadSlug("a~b~c@example.com")).toBe(false);
  });

  it("rejects contact names", () => {
    expect(looksLikeThreadSlug("Alice Smith")).toBe(false);
    expect(looksLikeThreadSlug("brian")).toBe(false);
  });

  it("rejects malformed slugs (wrong segment count or empty segments)", () => {
    expect(looksLikeThreadSlug("alice~imsg")).toBe(false); // 2 parts
    expect(looksLikeThreadSlug("alice~imsg~a3f2~extra")).toBe(false); // 4 parts
    expect(looksLikeThreadSlug("~imsg~a3f2")).toBe(false); // empty name
    expect(looksLikeThreadSlug("alice~~a3f2")).toBe(false); // empty service
    expect(looksLikeThreadSlug("alice~imsg~")).toBe(false); // empty hash
  });

  it("returns false for undefined / empty input", () => {
    expect(looksLikeThreadSlug(undefined)).toBe(false);
    expect(looksLikeThreadSlug("")).toBe(false);
  });
});

describe("generateThreadSlug", () => {
  const baseInput = {
    chatIdentifier: "+61401990797",
    guid: "iMessage;-;+61401990797",
    displayName: null,
    serviceName: "iMessage",
    resolvedContactName: null,
    identityKey: "identifier:61401990797",
  };

  it("uses resolvedContactName when present (1-on-1)", () => {
    const slug = generateThreadSlug({ ...baseInput, resolvedContactName: "Alice Smith" });
    expect(slug).toMatch(/^alice-smith~imsg~[0-9a-f]{4}$/);
  });

  it("falls back to displayName for 1-on-1 without a resolved contact", () => {
    const slug = generateThreadSlug({ ...baseInput, displayName: "Alice via WhatsApp" });
    expect(slug).toMatch(/^alice-via-whatsapp~imsg~[0-9a-f]{4}$/);
  });

  it("falls back to the bare chat identifier when no name is available", () => {
    const slug = generateThreadSlug(baseInput);
    // "+" is stripped per the bare-identifier branch.
    expect(slug).toMatch(/^61401990797~imsg~[0-9a-f]{4}$/);
  });

  it("uses the group displayName for named group chats", () => {
    const slug = generateThreadSlug({
      ...baseInput,
      chatIdentifier: "chat123456",
      guid: "iMessage;+;chat123456",
      displayName: "Weekend Crew",
    });
    expect(slug).toMatch(/^weekend-crew~imsg~[0-9a-f]{4}$/);
  });

  it("uses the 'group' placeholder for unnamed group chats", () => {
    const slug = generateThreadSlug({
      ...baseInput,
      chatIdentifier: "chat123456",
      guid: "iMessage;+;chat123456",
      displayName: null,
    });
    expect(slug).toMatch(/^group~imsg~[0-9a-f]{4}$/);
  });

  it("ignores displayName that looks like the chat id (chat-prefixed)", () => {
    const slug = generateThreadSlug({
      ...baseInput,
      chatIdentifier: "chat123456",
      guid: "iMessage;+;chat123456",
      displayName: "chat123456",
    });
    expect(slug).toMatch(/^group~/);
  });

  it("uses sms service abbreviation when serviceName is SMS", () => {
    const slug = generateThreadSlug({
      ...baseInput,
      serviceName: "SMS",
      guid: "SMS;-;+61401990797",
      resolvedContactName: "Mum",
    });
    expect(slug).toMatch(/^mum~sms~[0-9a-f]{4}$/);
  });

  it("returns 'unknown' when nothing survives sanitisation", () => {
    const slug = generateThreadSlug({
      ...baseInput,
      chatIdentifier: "!!!",
      guid: "weird;-;!!!",
      displayName: null,
      resolvedContactName: null,
    });
    expect(slug).toMatch(/^unknown~imsg~[0-9a-f]{4}$/);
  });

  it("is deterministic — same identityKey produces same hash", () => {
    const a = generateThreadSlug({ ...baseInput, resolvedContactName: "Alice" });
    const b = generateThreadSlug({ ...baseInput, resolvedContactName: "Alice" });
    expect(a).toBe(b);
  });

  it("is STABLE across a contact's legs — same identityKey, different guid/identifier → same slug", () => {
    // The phone leg and the email leg of one contact share contact:5.
    const phoneLeg = generateThreadSlug({
      ...baseInput,
      identityKey: "contact:5",
      guid: "iMessage;-;+61401990797",
      chatIdentifier: "+61401990797",
      resolvedContactName: "Alice",
    });
    const emailLeg = generateThreadSlug({
      ...baseInput,
      identityKey: "contact:5",
      guid: "iMessage;-;alice@example.com",
      chatIdentifier: "alice@example.com",
      resolvedContactName: "Alice",
    });
    expect(phoneLeg).toBe(emailLeg);
  });

  it("separates distinct identities even when the display name matches", () => {
    const alice5 = generateThreadSlug({
      ...baseInput,
      identityKey: "contact:5",
      resolvedContactName: "Alice",
    });
    const alice6 = generateThreadSlug({
      ...baseInput,
      identityKey: "contact:6",
      resolvedContactName: "Alice",
    });
    expect(alice5).not.toBe(alice6);
    expect(alice5.split("~")[0]).toBe(alice6.split("~")[0]); // same name part
  });

  it("falls back to hashing the guid when no identityKey is given", () => {
    const { identityKey: _omit, ...noKey } = baseInput;
    const slug = generateThreadSlug({ ...noKey, resolvedContactName: "Alice" });
    expect(slug).toMatch(/^alice~imsg~[0-9a-f]{4}$/);
  });
});
