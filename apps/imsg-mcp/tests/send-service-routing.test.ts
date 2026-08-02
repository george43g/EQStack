/**
 * Service-routing tests for the send path.
 *
 * Regression context: Messages.app's participant resolution is lazy — the
 * AppleScript on-error fallback can never detect a wrong-service send (an
 * SMS-only number "sends" fine via the iMessage service and silently never
 * delivers). The fix routes on chat.db ground truth: the slug store's
 * persisted service for slug sends, the existing conversation's service for
 * raw-recipient sends. These tests pin (a) the ordering decision, (b) the
 * generated script shape, and (c) that handleSendMessage actually threads
 * the known service through to the AppleScript layer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildParticipantSendScript, sendServiceOrder } from "../src/applescript.js";

vi.mock("../src/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/applescript.js")>();
  return {
    ...actual,
    checkMessagesAvailable: vi.fn(async () => true),
    sendMessageReliable: vi.fn(async () => ({ success: true, timestamp: new Date() })),
    sendMessageAlt: vi.fn(async () => ({ success: true, timestamp: new Date() })),
    sendAttachment: vi.fn(async () => ({ success: true, timestamp: new Date() })),
    sendToChat: vi.fn(async () => ({ success: true, timestamp: new Date() })),
    sendToChatId: vi.fn(async () => ({ success: true, timestamp: new Date() })),
  };
});

import { sendMessageReliable } from "../src/applescript.js";
import { IMessageMCPServer } from "../src/index.js";

describe("sendServiceOrder", () => {
  it("emails are iMessage-only (SMS can never carry them)", () => {
    expect(sendServiceOrder("a@b.com")).toEqual(["iMessage"]);
    expect(sendServiceOrder("a@b.com", "SMS")).toEqual(["iMessage"]);
  });

  it("phones default to iMessage-first with SMS fallback", () => {
    expect(sendServiceOrder("+15550000100")).toEqual(["iMessage", "SMS"]);
    expect(sendServiceOrder("+15550000100", "iMessage")).toEqual(["iMessage", "SMS"]);
  });

  it("known-SMS threads attempt SMS first", () => {
    expect(sendServiceOrder("+15550000100", "SMS")).toEqual(["SMS", "iMessage"]);
  });
});

describe("buildParticipantSendScript", () => {
  it("SMS-first order puts SMS as the primary attempt, iMessage in on error", () => {
    const script = buildParticipantSendScript({
      order: ["SMS", "iMessage"],
      escapedRecipient: "+15550000100",
      payload: "msgBody",
      prelude: 'set msgBody to read (POSIX file "/tmp/x") as «class utf8»',
    });
    const smsIdx = script.indexOf("service type = SMS");
    const errIdx = script.indexOf("on error");
    const imsgIdx = script.indexOf("service type = iMessage");
    expect(smsIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeGreaterThan(smsIdx);
    expect(imsgIdx).toBeGreaterThan(errIdx);
  });

  it("iMessage-first order keeps SMS in the on-error branch", () => {
    const script = buildParticipantSendScript({
      order: ["iMessage", "SMS"],
      escapedRecipient: "+15550000100",
      payload: "msgBody",
    });
    expect(script).toMatch(/on error[\s\S]*service type = SMS/);
  });

  it("single-service order emits no try block", () => {
    const script = buildParticipantSendScript({
      order: ["iMessage"],
      escapedRecipient: "a@b.com",
      payload: "msgBody",
    });
    expect(script).not.toContain("on error");
    expect(script).not.toContain("service type = SMS");
  });
});

describe("handleSendMessage service routing (chat.db ground truth)", () => {
  let server: any;
  const reliableSpy = vi.mocked(sendMessageReliable);

  beforeEach(() => {
    server = new IMessageMCPServer();
    reliableSpy.mockClear();
  });

  function stubSlug(service: string) {
    server.db.getSlugRecord = () => ({
      slug: "test~sms~beef",
      chatGuid: "SMS;-;+15550009999",
      chatIdentifier: "+15550009999",
      displayName: null,
      service,
      isGroup: false,
      participants: "",
      updatedAt: 0,
    });
  }

  it("slug on an SMS thread sends SMS-first", async () => {
    stubSlug("SMS");
    await server.handleSendMessage({ threadSlug: "test~sms~beef", message: "hi" });
    expect(reliableSpy).toHaveBeenCalledWith("+15550009999", "hi", "SMS");
  });

  it("slug on an iMessage thread sends iMessage-first", async () => {
    stubSlug("iMessage");
    await server.handleSendMessage({ threadSlug: "test~sms~beef", message: "hi" });
    expect(reliableSpy).toHaveBeenCalledWith("+15550009999", "hi", "iMessage");
  });

  it("raw recipient with an existing SMS conversation sends SMS-first", async () => {
    server.db.findChatByHandle = async () => ({
      chatIdentifier: "+15550009999",
      rawIdentifier: "+15550009999",
      serviceType: "SMS",
      isGroupChat: false,
      displayName: null,
      threadSlug: "test~sms~beef",
      participants: [],
    });
    // Resolve the post-send confirm poll immediately: the just-sent from-me
    // row "lands" on the first getMessagesForChat scan.
    server.db.getMessagesForChat = async () => [
      { id: 1, text: "hi", isFromMe: true, date: new Date(), hasAttachments: false },
    ];
    await server.handleSendMessage({ recipient: "+15550009999", message: "hi" });
    expect(reliableSpy).toHaveBeenCalledWith("+15550009999", "hi", "SMS");
  });

  it("raw recipient with no history defaults to iMessage-first (undefined preference)", async () => {
    server.db.findChatByHandle = async () => null;
    await server.handleSendMessage({ recipient: "+15550009999", message: "hi" });
    expect(reliableSpy).toHaveBeenCalledWith("+15550009999", "hi", undefined);
  });
});

describe("check_imessage_availability DB-first", () => {
  it("reports the existing conversation's service as authoritative", async () => {
    const server: any = new IMessageMCPServer();
    server.db.findChatByHandle = async () => ({
      chatIdentifier: "+15550009999",
      rawIdentifier: "+15550009999",
      serviceType: "SMS",
      isGroupChat: false,
      displayName: null,
      threadSlug: "test~sms~beef",
      participants: [],
    });
    const res = await server.handleCheckImessageAvailability({ handle: "+15550009999" });
    expect(res.structuredContent.service).toBe("SMS");
    expect(res.structuredContent.reachable).toBe(true);
    expect(res.content[0].text).toContain("existing conversation");
  });
});
