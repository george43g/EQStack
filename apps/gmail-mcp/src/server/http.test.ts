// HTTP transport tests for src/server/http.ts.
//
// Covers gap items 12.9 (startHttpServer refuses to start without a token —
// SECURITY-relevant), 12.10 (/health 200 vs 503 branches), 12.13
// (timingSafeEqual constant-time correctness), and 12.14 (readJsonBody body
// cap + invalid-JSON rejection). All HTTP exchanges use an ephemeral port
// (`port: 0`) so suites can run in parallel without collisions.

import http from "node:http";
import type { WatchdogState } from "@george43g/robustness";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HttpServerHandle, startHttpServer } from "./http.js";

// Partial barrel mock: the /health route passes readWatchdogState() into the
// REAL snapshotHealth (injectable-state param, robustness 0.10.0), so tests
// drive the actual status ladder by mutating this synthetic state.
const mockState = vi.hoisted(
  (): WatchdogState => ({
    startedAt: Date.now(),
    eventLoopP99Ms: 0,
    eventLoopMaxMs: 0,
    eventLoopSustainedCount: 0,
    lastEventLoopSampleTs: Date.now(),
    rssMb: 0,
    heapMb: 0,
    heapHistory: [],
    lastActivityTs: Date.now(),
    killReason: null,
    memorySampled: false,
  }),
);

vi.mock("@george43g/robustness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@george43g/robustness")>()),
  readWatchdogState: () => mockState,
}));

const TOKEN_ENV = "GMAIL_HTTP_TEST_TOKEN";
const TEST_TOKEN = "test-secret-do-not-share";

function makeBareServer(): McpServer {
  // The HTTP transport only needs a real MCP server for /mcp routing.
  // /health and the auth gate run before transport.handleRequest is called,
  // so a bare server with default capabilities is fine here.
  return new McpServer({ name: "gmail-test", version: "0.0.0" }, { capabilities: { tools: {} } });
}

interface FetchResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function requestHttp(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(",");
          }
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

let handle: HttpServerHandle | undefined;

beforeEach(() => {
  mockState.killReason = null;
  mockState.eventLoopP99Ms = 0;
  process.env[TOKEN_ENV] = TEST_TOKEN;
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  delete process.env[TOKEN_ENV];
  mockState.killReason = null;
});

describe("startHttpServer token requirement (12.9 — SECURITY)", () => {
  it("throws synchronously when the token env var is unset", async () => {
    delete process.env[TOKEN_ENV];
    const server = makeBareServer();
    await expect(
      startHttpServer({
        server,
        port: 0,
        bind: "127.0.0.1",
        tokenEnv: TOKEN_ENV,
        getCounters: () => ({ toolCalls: 0, recentErrors: 0 }),
        log: () => {},
      }),
    ).rejects.toThrow(/HTTP mode requires .* bearer token/);
  });

  it("throws when the token env var is set to whitespace only", async () => {
    process.env[TOKEN_ENV] = "   \t  ";
    const server = makeBareServer();
    await expect(
      startHttpServer({
        server,
        port: 0,
        bind: "127.0.0.1",
        tokenEnv: TOKEN_ENV,
        getCounters: () => ({ toolCalls: 0, recentErrors: 0 }),
        log: () => {},
      }),
    ).rejects.toThrow(/non-empty bearer token/);
  });
});

describe("/health endpoint (12.10)", () => {
  it("returns 200 when the watchdog reports healthy", async () => {
    handle = await startHttpServer({
      server: makeBareServer(),
      port: 0,
      bind: "127.0.0.1",
      tokenEnv: TOKEN_ENV,
      getCounters: () => ({ toolCalls: 7, recentErrors: 0 }),
      log: () => {},
    });

    const res = await requestHttp(handle.port, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/Status: healthy/);
    expect(res.body).toContain("Tool calls: 7");
  });

  it("returns 503 when the watchdog has recorded a kill reason (unhealthy branch)", async () => {
    handle = await startHttpServer({
      server: makeBareServer(),
      port: 0,
      bind: "127.0.0.1",
      tokenEnv: TOKEN_ENV,
      getCounters: () => ({ toolCalls: 0, recentErrors: 0 }),
      log: () => {},
    });

    // Drive the unhealthy branch in the real snapshotHealth: any non-null
    // killReason forces status="unhealthy", which the HTTP layer maps to 503.
    mockState.killReason = "test_forced_kill";

    const res = await requestHttp(handle.port, "GET", "/health");
    expect(res.status).toBe(503);
    expect(res.body).toMatch(/Status: unhealthy/);
    expect(res.body).toContain("test_forced_kill");
  });
});

describe("/mcp bearer auth + readJsonBody (12.13 / 12.14)", () => {
  it("rejects oversized POST bodies before they reach the transport (12.14)", async () => {
    handle = await startHttpServer({
      server: makeBareServer(),
      port: 0,
      bind: "127.0.0.1",
      tokenEnv: TOKEN_ENV,
      getCounters: () => ({ toolCalls: 0, recentErrors: 0 }),
      log: () => {},
    });

    // 4 MB + 1 byte triggers the body cap in readJsonBody. The server
    // destroys the incoming request as soon as the cap is exceeded — the
    // client sees a socket hang-up rather than a clean 500, which is the
    // intended behaviour (do not echo arbitrary-size error bodies back).
    const huge = "a".repeat(4 * 1024 * 1024 + 1);
    let observed: { status: number; body: string } | Error;
    try {
      observed = await requestHttp(handle.port, "POST", "/mcp", {
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
          "content-length": String(huge.length),
        },
        body: huge,
      });
    } catch (err) {
      observed = err as Error;
    }

    if (observed instanceof Error) {
      // Socket-hang-up path — the most common outcome.
      expect(observed.message.toLowerCase()).toMatch(/socket|hang|econn|epipe|reset/);
    } else {
      // If the server raced and managed to write a 500 first, accept that.
      expect(observed.status).toBe(500);
      expect(observed.body).toMatch(/exceeds .* bytes/);
    }
  });

  it("rejects invalid JSON body with 500 (12.14)", async () => {
    handle = await startHttpServer({
      server: makeBareServer(),
      port: 0,
      bind: "127.0.0.1",
      tokenEnv: TOKEN_ENV,
      getCounters: () => ({ toolCalls: 0, recentErrors: 0 }),
      log: () => {},
    });

    const res = await requestHttp(handle.port, "POST", "/mcp", {
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{not json at all",
    });

    expect(res.status).toBe(500);
    expect(res.body).toMatch(/Invalid JSON body/);
  });

  it("rejects bearer tokens that differ only by one byte (12.13 constant-time compare)", async () => {
    handle = await startHttpServer({
      server: makeBareServer(),
      port: 0,
      bind: "127.0.0.1",
      tokenEnv: TOKEN_ENV,
      getCounters: () => ({ toolCalls: 0, recentErrors: 0 }),
      log: () => {},
    });

    // Same length as TEST_TOKEN, differs only in the final byte. timingSafeEqual
    // loops the full length regardless of mismatch position; what we assert
    // here is that the comparison is BYTE-EXACT (no prefix match, no slack).
    const wrong = `${TEST_TOKEN.slice(0, -1)}X`;
    expect(wrong.length).toBe(TEST_TOKEN.length);

    const res = await requestHttp(handle.port, "POST", "/mcp", {
      headers: {
        Authorization: `Bearer ${wrong}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("rejects bearer tokens of different length (12.13 length short-circuit)", async () => {
    handle = await startHttpServer({
      server: makeBareServer(),
      port: 0,
      bind: "127.0.0.1",
      tokenEnv: TOKEN_ENV,
      getCounters: () => ({ toolCalls: 0, recentErrors: 0 }),
      log: () => {},
    });

    // A prefix of the real token must NOT authenticate, even though every
    // compared byte matches. (timingSafeEqual short-circuits on length.)
    const prefix = TEST_TOKEN.slice(0, 5);
    expect(prefix.length).toBeLessThan(TEST_TOKEN.length);

    const res = await requestHttp(handle.port, "POST", "/mcp", {
      headers: {
        Authorization: `Bearer ${prefix}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });
});
