/**
 * MCP Resources surface — uri pattern matching, error path. Doesn't
 * exercise the live DB; we just confirm the URI parser routes correctly
 * and the unknown-URI branch errors with a useful message.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMessageMCPServer } from "../src/index.js";

describe("MCP resources URI routing", () => {
  let server: any;

  beforeAll(() => {
    process.env.IMSG_DEV = "1";
    server = new IMessageMCPServer();
  });
  afterAll(async () => {
    delete process.env.IMSG_DEV;
    await server.db?.close();
  });

  it("messages://recent/{hours} resolves and returns the expected shape", async () => {
    const result = (await server.readResource("messages://recent/24")) as {
      windowHours: number;
      messages: unknown[];
    };
    expect(result.windowHours).toBe(24);
    expect(Array.isArray(result.messages)).toBe(true);
  });

  it("contacts:// returns a contacts array", async () => {
    const result = (await server.readResource("contacts://")) as {
      count: number;
      contacts: unknown[];
    };
    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.contacts)).toBe(true);
  });

  it("unknown URIs throw", async () => {
    await expect(server.readResource("garbage://nope")).rejects.toThrow(/Unknown resource URI/);
  });
});
