import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SCOPES } from "../scopes.js";
import {
  _resetForTests,
  getAuthorizedScopes,
  getGmail,
  getOAuth2Client,
  getRecentErrorCount,
  getToolCallCount,
  incrementToolCallCount,
  isSessionReady,
  recordToolError,
  setAuthorizedScopes,
  setSession,
} from "./session.js";

const fakeOauth = { dummy: true } as any;
const fakeGmail = { users: {} } as any;

beforeEach(() => {
  _resetForTests();
});

describe("session ready state", () => {
  it("starts un-initialized", () => {
    expect(isSessionReady()).toBe(false);
    expect(() => getOAuth2Client()).toThrow(/Session not initialised/);
    expect(() => getGmail()).toThrow(/Session not initialised/);
  });

  it("is ready after setSession", () => {
    setSession({ oauth2Client: fakeOauth, gmail: fakeGmail });
    expect(isSessionReady()).toBe(true);
    expect(getOAuth2Client()).toBe(fakeOauth);
    expect(getGmail()).toBe(fakeGmail);
  });
});

describe("scopes", () => {
  it("defaults to DEFAULT_SCOPES", () => {
    expect(getAuthorizedScopes()).toEqual(DEFAULT_SCOPES);
  });

  it("setAuthorizedScopes overrides", () => {
    setAuthorizedScopes(["gmail.readonly"]);
    expect(getAuthorizedScopes()).toEqual(["gmail.readonly"]);
  });

  it("setSession can include scopes", () => {
    setSession({
      oauth2Client: fakeOauth,
      gmail: fakeGmail,
      authorizedScopes: ["gmail.modify"],
    });
    expect(getAuthorizedScopes()).toEqual(["gmail.modify"]);
  });
});

describe("counters", () => {
  it("tool call count starts at 0 and increments", () => {
    expect(getToolCallCount()).toBe(0);
    incrementToolCallCount();
    incrementToolCallCount();
    expect(getToolCallCount()).toBe(2);
  });

  it("recent error count uses a 5-minute sliding window", () => {
    // Record three errors "now"
    recordToolError();
    recordToolError();
    recordToolError();
    expect(getRecentErrorCount()).toBe(3);
  });

  it("evicts errors older than 5 minutes", () => {
    const realNow = Date.now;
    let now = 1_000_000_000_000;
    Date.now = () => now;
    try {
      recordToolError();
      recordToolError();
      // Advance time 10 minutes
      now += 10 * 60_000;
      recordToolError();
      expect(getRecentErrorCount()).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });
});
