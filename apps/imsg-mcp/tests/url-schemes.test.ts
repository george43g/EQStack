import { describe, expect, it } from "vitest";
import { buildChatAppUri, getInstalledChatApps } from "../src/url-schemes.js";

describe("getInstalledChatApps", () => {
  it("always includes Messages on macOS (always present)", () => {
    const apps = getInstalledChatApps();
    const messages = apps.find((a) => a.name === "Messages");
    expect(messages).toBeDefined();
  });

  it("returns a non-empty array", () => {
    expect(getInstalledChatApps().length).toBeGreaterThan(0);
  });
});

describe("buildChatAppUri", () => {
  it("Messages → imessage:// URI for phone", () => {
    const r = buildChatAppUri("Messages", "+15555550100");
    expect(r?.uri).toBe("imessage://%2B15555550100");
  });

  it("FaceTime → facetime:// URI", () => {
    const r = buildChatAppUri("FaceTime", "+15555550100");
    expect(r?.uri).toBe("facetime://%2B15555550100");
  });

  it("SMS supports body param", () => {
    const r = buildChatAppUri("SMS", "+15555550100", "hi there");
    expect(r?.supportsBody).toBe(true);
    expect(r?.uri).toContain("body=hi%20there");
  });

  it("returns null for unknown app names", () => {
    expect(buildChatAppUri("NotARealApp", "+15555550100")).toBeNull();
  });

  it("Signal rejects non-phone handles", () => {
    if (getInstalledChatApps().some((a) => a.name === "Signal")) {
      expect(buildChatAppUri("Signal", "alice@example.com")).toBeNull();
    }
  });
});
