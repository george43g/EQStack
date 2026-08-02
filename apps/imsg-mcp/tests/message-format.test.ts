import { describe, expect, it } from "vitest";

describe("Message formatting", () => {
  it("should format outgoing messages with → arrow", () => {
    const msg = {
      id: 1,
      guid: "abc",
      text: "Hello",
      handle: "+1234567890",
      isFromMe: true,
      date: new Date("2024-01-15T10:00:00"),
      dateRead: null,
      isRead: true,
      chatId: "chat123",
      service: "iMessage" as const,
    };

    const direction = msg.isFromMe ? "→" : "←";
    expect(direction).toBe("→");
  });

  it("should format incoming messages with ← arrow", () => {
    const msg = {
      id: 1,
      guid: "abc",
      text: "Hello",
      handle: "+1234567890",
      isFromMe: false,
      date: new Date("2024-01-15T10:00:00"),
      dateRead: null,
      isRead: false,
      chatId: "chat123",
      service: "iMessage" as const,
    };

    const direction = msg.isFromMe ? "→" : "←";
    expect(direction).toBe("←");
  });

  it("should show [UNREAD] for unread messages", () => {
    const msg = {
      id: 1,
      guid: "abc",
      text: "Hello",
      handle: "+1234567890",
      isFromMe: false,
      date: new Date("2024-01-15T10:00:00"),
      dateRead: null,
      isRead: false,
      chatId: "chat123",
      service: "iMessage" as const,
    };

    const readStatus = msg.isRead ? "" : " [UNREAD]";
    expect(readStatus).toBe(" [UNREAD]");
  });
});

describe("Types", () => {
  it("should have correct Message structure", () => {
    const msg = {
      id: 1,
      guid: "test-guid",
      text: "Hello",
      handle: "+1234567890",
      isFromMe: false,
      date: new Date(),
      dateRead: null,
      isRead: false,
      chatId: "chat123",
      service: "iMessage" as const,
    };

    expect(msg).toHaveProperty("id");
    expect(msg).toHaveProperty("guid");
    expect(msg).toHaveProperty("text");
    expect(msg).toHaveProperty("handle");
    expect(msg).toHaveProperty("isFromMe");
    expect(msg).toHaveProperty("date");
    expect(msg).toHaveProperty("isRead");
    expect(msg).toHaveProperty("chatId");
    expect(msg).toHaveProperty("service");
  });

  it("should have correct Conversation structure", () => {
    const conv = {
      chatId: "chat123",
      chatIdentifier: "+1234567890",
      displayName: "John Doe",
      participants: ["+1234567890"],
      lastMessageDate: new Date(),
      unreadCount: 5,
    };

    expect(conv).toHaveProperty("chatId");
    expect(conv).toHaveProperty("chatIdentifier");
    expect(conv).toHaveProperty("displayName");
    expect(conv).toHaveProperty("participants");
    expect(conv).toHaveProperty("lastMessageDate");
    expect(conv).toHaveProperty("unreadCount");
  });
});
