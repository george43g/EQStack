/**
 * ADMIN listener — binds 127.0.0.1 ONLY. The mutating surface used by the
 * MCP server and CLI (both are thin clients of this API), plus
 * observability: SSE event feed and Prometheus metrics. Never reachable
 * through the tunnel; the public listener knows none of these routes.
 *
 * Inverted, not deleted (D-8): the seven mutating routes are a declarative
 * table parsing with the SAME Zod schemas as every other surface
 * (src/commands/specs.ts — INV-5/INV-6, fixing the D-31 coercion bugs), while
 * the transport concerns the registry has no opinion about — loopback bind,
 * long-poll cleanup, SSE redaction, error mapping, body cap, /healthz and
 * /metrics — are kept verbatim.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { redactValue } from "@george43g/robustness";
import { ZodError, z } from "zod";
import {
  AfterSeqSchema,
  BeforeMsSchema,
  EventLimitSchema,
  LimitSchema,
} from "../commands/contracts.js";
import type { CommandSpec } from "../commands/specs.js";
import {
  deleteRecording,
  endCall,
  placeCall,
  playDisclosure,
  sayOnCall,
  setRecording,
} from "../commands/specs.js";
import type { CallEvent } from "../domain/types.js";
import { logger } from "../log.js";
import { VERSION } from "../version.js";
import { type CallService, CallServiceError } from "./call-service.js";
import type { Metrics } from "./metrics.js";

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

/** One line, stable shape: "<first issue path>: <message>". */
function zodErrorMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "invalid input";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

// ── Query-string contracts (z.coerce because query values arrive as strings;
// non-numeric input is a 400, never a NaN that silently matches nothing) ────

const ListCallsQuerySchema = z.object({
  limit: z.coerce.number().pipe(LimitSchema).optional(),
  beforeMs: z.coerce.number().pipe(BeforeMsSchema).optional(),
});

const EventsQuerySchema = z.object({
  afterSeq: z.coerce.number().pipe(AfterSeqSchema).optional(),
  limit: z.coerce.number().pipe(EventLimitSchema).optional(),
  waitMs: z.coerce.number().optional(),
});

/** A present-but-empty query param keeps today's "absent" semantics. */
function queryParam(url: URL, name: string): string | undefined {
  return url.searchParams.get(name) || undefined;
}

// ── The mutating route table (Phase B step 7) ──────────────────────────────

interface AdminRoute {
  method: "POST" | "DELETE";
  pattern: RegExp;
  spec: CommandSpec;
  /** Success status — 201 for the two creations, 200 elsewhere. */
  status: 200 | 201;
  toArgs(match: RegExpMatchArray, body: Record<string, unknown>): unknown;
  run(service: CallService, args: never): Promise<unknown>;
}

/** Ties each row's `run` input to its spec's parsed type without casts. */
function route<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(row: {
  method: "POST" | "DELETE";
  pattern: RegExp;
  spec: CommandSpec<I, O>;
  status: 200 | 201;
  toArgs: (match: RegExpMatchArray, body: Record<string, unknown>) => unknown;
  run: (service: CallService, args: z.infer<I>) => Promise<unknown>;
}): AdminRoute {
  return row;
}

/**
 * The six mutating routes as data. Each row is: match → merge path captures
 * over the body (path wins) → `spec.input.parse` → call CallService directly
 * (this process is the single writer — INV-9). URL shapes are unchanged so
 * AdminClient does not fork; response codes and bodies are today's.
 */
const MUTATING_ROUTES: readonly AdminRoute[] = [
  route({
    method: "POST",
    pattern: /^\/calls$/,
    spec: placeCall,
    status: 201,
    toArgs: (_match, body) => body,
    run: async (service, args) => service.placeCall(args),
  }),
  route({
    method: "POST",
    pattern: /^\/calls\/([\w-]+)\/end$/,
    spec: endCall,
    status: 200,
    toArgs: (match, body) => ({ ...body, callId: match[1] }),
    run: async (service, { callId, reason }) => {
      await service.endCall(callId, reason ?? "operator_request");
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    pattern: /^\/calls\/([\w-]+)\/disclosure$/,
    spec: playDisclosure,
    status: 200,
    toArgs: (match) => ({ callId: match[1] }),
    run: async (service, { callId }) => {
      await service.playDisclosure(callId);
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    pattern: /^\/calls\/([\w-]+)\/say$/,
    spec: sayOnCall,
    status: 200,
    toArgs: (match, body) => ({ ...body, callId: match[1] }),
    run: async (service, { callId, text }) => {
      await service.say(callId, text);
      return { ok: true };
    },
  }),
  route({
    method: "POST",
    pattern: /^\/calls\/([\w-]+)\/recording$/,
    spec: setRecording,
    status: 200,
    toArgs: (match, body) => ({ ...body, callId: match[1] }),
    run: async (service, { callId, enabled }) => {
      await service.setRecording(callId, enabled);
      return { ok: true };
    },
  }),
  route({
    method: "DELETE",
    pattern: /^\/recordings\/([A-Za-z0-9]+)$/,
    spec: deleteRecording,
    status: 200,
    toArgs: (match, body) => ({ ...body, recordingSid: match[1] }),
    run: (service, { recordingSid, scope, confirm }) =>
      service.deleteRecording(recordingSid, scope, confirm),
  }),
];

/** Command names the REST route table covers — the parity test's REST leg. */
export const ROUTED_COMMANDS: readonly string[] = MUTATING_ROUTES.map((r) => r.spec.name);

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
        if (err instanceof ZodError) {
          json(res, 400, { error: zodErrorMessage(err) });
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
      const { limit, beforeMs } = ListCallsQuerySchema.parse({
        limit: queryParam(url, "limit"),
        beforeMs: queryParam(url, "beforeMs"),
      });
      return json(res, 200, {
        calls: this.service.store.listCalls({
          ...(beforeMs !== undefined ? { beforeMs } : {}),
          ...(limit !== undefined ? { limit } : {}),
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
      const query = EventsQuerySchema.parse({
        afterSeq: queryParam(url, "afterSeq"),
        limit: queryParam(url, "limit"),
        waitMs: queryParam(url, "waitMs"),
      });
      const afterSeq = query.afterSeq ?? 0;
      const limit = query.limit ?? 200;
      // Same clamp as before the inversion — out-of-range waits degrade, they don't 400.
      const waitMs = Math.min(Math.max(query.waitMs ?? 0, 0), 55_000);
      let events = this.service.store.getEvents(callId, afterSeq, limit);
      if (events.length === 0 && waitMs > 0) {
        await this.waitForCallEvent(callId, waitMs, res);
        events = this.service.store.getEvents(callId, afterSeq, limit);
      }
      // D-28/INV-11: same redaction as the SSE path.
      return json(res, 200, redactValue({ events }));
    }
    m = path.match(/^\/calls\/([\w-]+)\/transcript$/);
    if (method === "GET" && m) {
      // D-28/INV-11: same redaction as the SSE path.
      return json(
        res,
        200,
        redactValue({ transcript: this.service.store.getTranscript(m[1] as string) }),
      );
    }

    for (const r of MUTATING_ROUTES) {
      if (method !== r.method) continue;
      const match = path.match(r.pattern);
      if (!match) continue;
      const body = await readJsonBody(req);
      // ZodError → 400 with "<path>: <message>" via the constructor's catch.
      const args: unknown = r.spec.input.parse(r.toArgs(match, body));
      return json(res, r.status, await r.run(this.service, args as never));
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
      // D-28/INV-11: the poll batch is the same data as the SSE frames — redact it too.
      json(res, 200, redactValue({ events: this.service.store.getGlobalEvents(after) }));
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
