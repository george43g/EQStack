/**
 * TOOL listener (Phase R, D-91) — the consult channel. Exactly ONE route:
 *   POST /v1/consult   (ElevenLabs' webhook tool `consult_originator`)
 * Anything else is a 404. It is a separate listener from public-server.ts
 * because the trust model differs (D-59): a per-call bearer, never a Twilio
 * signature. Reached only through the tunnel's `tools.` hostname.
 *
 * Binds 127.0.0.1 ONLY. That is load-bearing for check 1 below: with no other
 * interface, the only remote peer that can reach this socket is cloudflared,
 * so CF-Connecting-IP is the header Cloudflare's edge set. (Any LOCAL process
 * could still forge it — every such process is George's; and checks 2–3 do
 * not depend on it.)
 *
 * Every check must pass, in this order; each failure is a 401 with no body,
 * holds nothing open, and bumps `tel_rejected_tool_calls_total` plus a
 * per-reason counter (Metrics has no labels, D-27):
 *   1. source IP — CF-Connecting-IP ∈ agentPlatform.consult.allowedSourceIps
 *      (ElevenLabs' published egress list,
 *      https://elevenlabs.io/docs/eleven-api/resources/ip-allowlisting).
 *      The TCP peer is always cloudflared on loopback, so the socket address
 *      proves nothing; Cloudflare documents CF-Connecting-IP as "the client IP
 *      address connecting to Cloudflare to the origin web server"
 *      (https://developers.cloudflare.com/fundamentals/reference/http-headers/).
 *      An empty list disables this check (gateway.ts warns at startup).
 *   2. bearer — `Authorization: Bearer <token>`; the token is hashed and the
 *      HASH is looked up, resolving exactly one live consult call.
 *   3. conversation id — body.conversation_id (EL fills it from
 *      system__conversation_id) must equal that call's conversation id; and
 *      when BOTH a stored phone-leg SID and a non-empty body.call_sid exist,
 *      they must match (either side absent → that check is skipped).
 * The body is Zod-parsed between 2 and 3 (check 3 reads it); a body that
 * fails to parse is a 400 and holds nothing open (INV-6).
 *
 * Group calls (PHASE-GC, D-105) add no route and no layer: `ask_agent` is this
 * route with one more body field, `agent`. After all three checks pass, a
 * meeting call without it, or any other call with it, is a 400.
 *
 * Nothing here logs the token, the question text or a tunnel URL (INV-11).
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { z } from "zod";
import type { Config } from "../config/schema.js";
import { CONSULT_ROUTE_PATH } from "../domain/agent-brief.js";
import { logger } from "../log.js";
import type { CallService, ConsultResult } from "./call-service.js";
import type { Metrics } from "./metrics.js";

export interface ToolServerDeps {
  cfg: Config;
  service: CallService;
  metrics: Metrics;
}

const MAX_BODY_BYTES = 16 * 1024;

export type ToolRejectReason = "source_ip" | "bearer" | "conversation_id" | "call_sid";

/**
 * What EL sends (PHASE-R § 1). `collect_question_id` may arrive as "" when
 * the LLM leaves it unset; that means "ask", not "collect".
 */
export const ConsultRequestSchema = z
  .object({
    question: z.string().max(2000).optional(),
    collect_question_id: z
      .string()
      .max(128)
      .optional()
      .transform((v) => (v?.trim() ? v.trim() : undefined)),
    conversation_id: z.string().min(1).max(256),
    call_sid: z.string().max(64).optional(),
    /**
     * Meeting calls only (PHASE-GC § 3, D-105): the member asked (`ask_agent`).
     * Required on a meeting call and refused on any other — checked AFTER the
     * three auth layers, so it reveals nothing to an unauthenticated caller.
     */
    agent: z.string().min(1).max(64).optional(),
  })
  .superRefine((b, ctx) => {
    if (!b.collect_question_id && !b.question?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["question"],
        message: "question is required unless collect_question_id is set",
      });
    }
  });

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** `::ffff:1.2.3.4` → `1.2.3.4`; anything that is not an IP → null. */
export function normalizeSourceIp(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^::ffff:/i, "");
  return isIP(v) ? v.toLowerCase() : null;
}

/** Constant-time string equality for the id checks (they are not secrets; it costs nothing). */
function sameString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class ToolServer {
  readonly server: Server;
  private allowed: ReadonlySet<string>;
  /** Held requests, so close() can release every one (PHASE-R step 6). */
  private held = new Set<AbortController>();

  constructor(private deps: ToolServerDeps) {
    const consult = deps.cfg.agentPlatform?.consult;
    if (!consult) throw new Error("agentPlatform.consult is required to start the tool listener");
    this.allowed = new Set(
      consult.allowedSourceIps.map((ip) => normalizeSourceIp(ip) ?? ip.toLowerCase()),
    );
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        logger.error("tool request failed", { error: (err as Error).message });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  }

  /** True when the source-IP check is off (empty list) — gateway.ts warns about it. */
  get sourceIpCheckDisabled(): boolean {
    return this.allowed.size === 0;
  }

  private reject(res: ServerResponse, reason: ToolRejectReason): void {
    this.deps.metrics.counter("tel_rejected_tool_calls_total", "Tool requests refused").inc();
    this.deps.metrics
      .counter(`tel_rejected_tool_calls_${reason}_total`, `Tool requests refused: ${reason}`)
      .inc();
    logger.warn("tool request rejected", { reason });
    res.writeHead(401);
    res.end();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // One request per connection: a refusal never leaves an unread body on a
    // reusable socket, and each EL tool call is a single request anyway.
    res.setHeader("Connection", "close");
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    // The one route. Everything else — any path, any method — is a 404.
    if (req.method !== "POST" || path !== CONSULT_ROUTE_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }

    // 1. Source IP (Cloudflare's edge sets the header; see the file header).
    if (this.allowed.size > 0) {
      const ip = normalizeSourceIp(req.headers["cf-connecting-ip"]);
      if (!ip || !this.allowed.has(ip)) return this.reject(res, "source_ip");
    }

    // 2. The per-call bearer → exactly one live consult call, by hash.
    const auth = req.headers.authorization;
    const token =
      typeof auth === "string" ? /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(auth)?.[1] : undefined;
    const call = token ? this.deps.service.resolveConsultBearer(token) : null;
    if (!call) return this.reject(res, "bearer");

    // Body: JSON only, capped, Zod-parsed (INV-6). Fails hold nothing open.
    const type = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type !== "application/json") {
      res.writeHead(415);
      res.end();
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (!res.headersSent) res.writeHead(err instanceof BodyTooLarge ? 413 : 400);
      res.end();
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const parsed = ConsultRequestSchema.safeParse(json);
    if (!parsed.success) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: parsed.error.issues[0]?.message ?? "invalid body" }));
      return;
    }
    const body = parsed.data;

    // 3. The conversation (and, when known, the phone leg) must be this call's.
    if (!call.providerCallId || !sameString(body.conversation_id, call.providerCallId)) {
      return this.reject(res, "conversation_id");
    }
    // The call SID is a belt, not a layer: checked only when BOTH sides have
    // one (a text session or an EL response without callSid leaves one side
    // empty). The bearer + conversation id stay the authentication (D-91).
    const legSid = this.deps.service.store.getPhoneLegSid(call.id);
    const bodySid = body.call_sid?.trim() ?? "";
    const callSidChecked = Boolean(legSid) && bodySid !== "";
    // A boolean only — never the SID itself.
    logger.info("consult call-sid check", { callSidChecked });
    if (callSidChecked && !sameString(bodySid, legSid as string)) {
      return this.reject(res, "call_sid");
    }

    // PHASE-GC: `agent` is required on a meeting call and refused elsewhere.
    const meeting = this.deps.service.meetingMembersOf(call.id) !== null;
    if (meeting !== (body.agent !== undefined)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: meeting
            ? "agent is required on a meeting call"
            : "agent is only accepted on a meeting call",
        }),
      );
      return;
    }

    // Held until answered, timed out, the call ends, EL hangs up, or close().
    const ac = new AbortController();
    this.held.add(ac);
    const onClose = () => {
      if (!res.writableFinished) ac.abort();
    };
    res.on("close", onClose);
    let result: ConsultResult;
    try {
      result = await this.deps.service.askConsult(
        call.id,
        {
          question: body.question,
          collectQuestionId: body.collect_question_id,
          ...(body.agent !== undefined ? { agent: body.agent } : {}),
        },
        ac.signal,
      );
    } finally {
      this.held.delete(ac);
      res.off("close", onClose);
    }
    logger.info("consult tool call", { callId: call.id, status: result.status });
    if (res.destroyed) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  /** Loopback only (D-91) — the tunnel is the one way in. */
  listen(port: number): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, "127.0.0.1", () => resolve()));
  }

  /** Releases every held request (each answers `unavailable`), then closes. */
  close(): Promise<void> {
    for (const ac of this.held) ac.abort();
    this.server.closeIdleConnections?.();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
