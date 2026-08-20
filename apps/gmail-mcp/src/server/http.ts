// HTTP transport for Gmail-MCP-Server (Phase G).
//
// Wraps a configured MCP `Server` instance in a Node http.Server using the
// SDK's StreamableHTTPServerTransport. Bearer-token auth on /mcp; /health is
// open so reverse-proxy probes work without credentials.
//
// Single-tenant by design: one server process = one Gmail account, with
// credentials loaded once at startup via the standard chain
// (GMAIL_CREDENTIALS_JSON / GMAIL_CREDENTIALS_OP / file). Multi-tenant is a
// future Phase G2 if a real use case appears.
//
// TLS is delegated to a reverse proxy (Caddy / nginx / Cloudflare Tunnel /
// Cloud Run). The bind default is 127.0.0.1 so direct Internet exposure
// requires an explicit `--bind 0.0.0.0`.

import { randomUUID } from "node:crypto";
import http from "node:http";
import { formatHealthText } from "@george43g/robustness";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { takeHealthSnapshot } from "../core/health-snapshot.js";

export interface HttpServerOptions {
  server: McpServer;
  port: number;
  bind: string;
  // Env var name to read the bearer token from. Server refuses to start if
  // the named env var is unset/empty.
  tokenEnv: string;
  // Counters for /health output.
  getCounters: () => { toolCalls: number; recentErrors: number };
  log?: (line: string) => void;
}

export interface HttpServerHandle {
  close(): Promise<void>;
  port: number;
  url: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB — generous for any MCP payload

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const expectedToken = process.env[opts.tokenEnv];
  if (!expectedToken || expectedToken.trim().length === 0) {
    throw new Error(
      `HTTP mode requires ${opts.tokenEnv} to be set to a non-empty bearer token. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }

  // Stateful transport: server hands out a session ID on initialize; clients
  // include it in `mcp-session-id` on subsequent requests. Required because
  // MCP semantics depend on initialize→tools/list→tools/call sharing state
  // (capabilities, AbortSignal plumbing). Stateless mode (sessionIdGenerator
  // undefined) loses initialize state between requests.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await opts.server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (method === "GET" && (url === "/health" || url.startsWith("/health?"))) {
        const snap = takeHealthSnapshot(opts.getCounters());
        res.writeHead(snap.status === "unhealthy" ? 503 : 200, {
          "content-type": "text/plain; charset=utf-8",
        });
        res.end(formatHealthText(snap));
        return;
      }

      if (!url.startsWith("/mcp")) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found. Use POST /mcp for MCP requests, GET /health for status.");
        return;
      }

      // Bearer auth — required for every /mcp request.
      const authHeader = (req.headers.authorization ?? "").trim();
      const provided = authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : "";
      if (!provided || !timingSafeEqual(provided, expectedToken)) {
        res.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": 'Bearer realm="gmail-mcp"',
        });
        res.end("Unauthorized. Provide an Authorization: Bearer <token> header.");
        return;
      }

      // Read body (POST) or pass through (GET — Streamable HTTP allows GET for SSE).
      let body: unknown;
      if (method === "POST") {
        body = await readJsonBody(req);
      }

      await transport.handleRequest(req, res, body);
    } catch (err) {
      const e = err as Error;
      log(`http_error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Internal error: ${e.message}`);
      } else {
        try {
          res.end();
        } catch {
          /* swallow */
        }
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.bind, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : opts.port;
  const url = `http://${opts.bind}:${actualPort}`;
  log(`gmail-mcp HTTP server listening on ${url}`);
  log(`  POST ${url}/mcp     — MCP Streamable HTTP (Authorization: Bearer required)`);
  log(`  GET  ${url}/health  — health snapshot (no auth)`);

  return {
    port: actualPort,
    url,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await transport.close();
    },
  };
}

/**
 * Constant-time string comparison to prevent timing attacks on the bearer
 * token check. node:crypto.timingSafeEqual requires equal-length Buffers, so
 * we wrap that handling here.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Quick length check is fine — leaking length of the secret is acceptable.
  if (a.length !== b.length) return false;
  // node:crypto could be used; for simplicity in the hot path do a manual
  // constant-time compare. Loop runs in O(len) regardless of mismatch position.
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}
