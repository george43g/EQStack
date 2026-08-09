/**
 * ADMIN listener — binds 127.0.0.1 ONLY. The mutating surface used by the
 * MCP server and CLI (both are thin clients of this API), plus
 * observability: SSE event feed and Prometheus metrics. Never reachable
 * through the tunnel; the public listener knows none of these routes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { redactValue } from "@george43g/robustness";
import type { CallEvent } from "../domain/types.js";
import { logger } from "../log.js";
import { type CallService, CallServiceError } from "./call-service.js";
import type { Metrics } from "./metrics.js";

export const VERSION = "0.1.0";

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export class AdminServer {
  readonly server: Server;

  constructor(
    private service: CallService,
    private metrics: Metrics,
  ) {
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        if (err instanceof CallServiceError) {
          json(res, err.httpStatus, { error: err.message });
          return;
        }
        logger.error("admin request failed", { error: (err as Error).message });
        if (!res.headersSent) json(res, 500, { error: "internal error" });
        else res.end();
      });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/healthz") {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        activeCalls: this.service.store.activeCallCount(),
      });
    }
    if (method === "GET" && path === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(this.metrics.renderProm());
      return;
    }
    if (method === "GET" && path === "/events") {
      return this.handleEvents(url, res);
    }
    if (method === "GET" && path === "/calls") {
      const beforeMs = url.searchParams.get("beforeMs");
      const limit = url.searchParams.get("limit");
      return json(res, 200, {
        calls: this.service.store.listCalls({
          ...(beforeMs ? { beforeMs: Number(beforeMs) } : {}),
          ...(limit ? { limit: Number(limit) } : {}),
        }),
      });
    }

    let m = path.match(/^\/calls\/([\w-]+)$/);
    if (method === "GET" && m) {
      const call = this.service.store.getCall(m[1] as string);
      if (!call) return json(res, 404, { error: "unknown call" });
      return json(res, 200, { call });
    }
    m = path.match(/^\/calls\/([\w-]+)\/events$/);
    if (method === "GET" && m) {
      const callId = m[1] as string;
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const waitMs = Math.min(Math.max(Number(url.searchParams.get("waitMs") ?? 0), 0), 55_000);
      let events = this.service.store.getEvents(callId, afterSeq, limit);
      if (events.length === 0 && waitMs > 0) {
        await this.waitForCallEvent(callId, waitMs, res);
        events = this.service.store.getEvents(callId, afterSeq, limit);
      }
      return json(res, 200, { events });
    }
    m = path.match(/^\/calls\/([\w-]+)\/transcript$/);
    if (method === "GET" && m) {
      return json(res, 200, { transcript: this.service.store.getTranscript(m[1] as string) });
    }

    if (method === "POST" && path === "/requests") {
      const body = await readJsonBody(req);
      if (body.mode !== undefined && body.mode !== "llm" && body.mode !== "direct") {
        return json(res, 400, { error: "mode must be llm | direct" });
      }
      const request = this.service.prepare({
        recipient: String(body.recipient ?? ""),
        objective: String(body.objective ?? ""),
        context: body.context === undefined ? undefined : String(body.context),
        profile: body.profile === undefined ? undefined : String(body.profile),
        record: body.record === undefined ? undefined : Boolean(body.record),
        mode: body.mode === undefined ? undefined : (body.mode as "llm" | "direct"),
      });
      return json(res, 201, { request });
    }
    if (method === "POST" && path === "/calls") {
      const body = await readJsonBody(req);
      const call = await this.service.start(String(body.requestId ?? ""), body.confirm === true);
      return json(res, 201, { call });
    }
    m = path.match(/^\/calls\/([\w-]+)\/end$/);
    if (method === "POST" && m) {
      const body = await readJsonBody(req);
      await this.service.endCall(m[1] as string, String(body.reason ?? "operator_request"));
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/calls\/([\w-]+)\/disclosure$/);
    if (method === "POST" && m) {
      await this.service.playDisclosure(m[1] as string);
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/calls\/([\w-]+)\/say$/);
    if (method === "POST" && m) {
      const body = await readJsonBody(req);
      await this.service.say(m[1] as string, String(body.text ?? ""));
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/calls\/([\w-]+)\/recording$/);
    if (method === "POST" && m) {
      const body = await readJsonBody(req);
      await this.service.setRecording(m[1] as string, body.enabled === true);
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/recordings\/([A-Za-z0-9]+)$/);
    if (method === "DELETE" && m) {
      const body = await readJsonBody(req);
      const scope = String(body.scope ?? "");
      if (scope !== "local" && scope !== "provider" && scope !== "both") {
        return json(res, 400, { error: "scope must be local | provider | both" });
      }
      const result = await this.service.deleteRecording(
        m[1] as string,
        scope,
        body.confirm === true,
      );
      return json(res, 200, result);
    }

    json(res, 404, { error: "not found" });
  }

  /** Long-poll support: resolve on the next event for callId, timeout, or client disconnect. */
  private waitForCallEvent(callId: string, waitMs: number, res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.service.events.off("event", listener);
        res.off("close", done);
        resolve();
      };
      const listener = (event: CallEvent) => {
        if (event.callId === callId) done();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref();
      this.service.events.on("event", listener);
      res.on("close", done);
    });
  }

  /** SSE by default; `?poll=1` returns a JSON batch for cursor-polling clients. */
  private handleEvents(url: URL, res: ServerResponse): void {
    const after = Number(url.searchParams.get("after") ?? 0);
    if (url.searchParams.get("poll") === "1") {
      json(res, 200, { events: this.service.store.getGlobalEvents(after) });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const event of this.service.store.getGlobalEvents(after)) {
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(redactValue(event))}\n\n`);
    }
    const listener = (event: CallEvent) => {
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(redactValue(event))}\n\n`);
    };
    this.service.events.on("event", listener);
    res.on("close", () => this.service.events.off("event", listener));
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, "127.0.0.1", () => resolve()));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
