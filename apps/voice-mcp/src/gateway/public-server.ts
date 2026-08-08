/**
 * PUBLIC listener — the only surface a tunnel exposes. Exactly three routes:
 *   POST /twilio/status     (call status callbacks)
 *   POST /twilio/recording  (recording callbacks)
 *   WS   /relay/<token>     (ConversationRelay session)
 * Every request must carry a valid X-Twilio-Signature computed against the
 * PUBLIC url (publicBaseUrl + path); anything else is rejected. Admin,
 * metrics, and live events live on the separate localhost listener.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { validateTwilioSignature } from "../adapters/telephony/twilio-signature.js";
import { type Config, effectiveCallSettings } from "../config/schema.js";
import type { Clock, LlmAdapter } from "../domain/ports.js";
import { logger } from "../log.js";
import type { CallService } from "./call-service.js";
import type { Metrics } from "./metrics.js";
import { RelaySession } from "./session.js";

export interface PublicServerDeps {
  cfg: Config;
  service: CallService;
  llm: LlmAdapter;
  twilioAuthToken: string;
  metrics: Metrics;
  clock: Clock;
}

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) params[k] = v;
  return params;
}

export class PublicServer {
  readonly server: Server;
  private wss: WebSocketServer;
  private publicBase: string;

  constructor(private deps: PublicServerDeps) {
    const base = deps.cfg.server.publicBaseUrl;
    if (!base) throw new Error("server.publicBaseUrl is required to start the public listener");
    this.publicBase = base.replace(/\/$/, "");
    this.server = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        logger.error("public request failed", { error: (err as Error).message });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const rejected = (code: number, reason: string) => {
        logger.warn("relay upgrade rejected", { reason });
        socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
        socket.destroy();
      };
      const url = new URL(req.url ?? "/", this.publicBase);
      const match = url.pathname.match(/^\/relay\/([A-Za-z0-9]+)$/);
      if (!match) return rejected(404, "Not Found");
      const signature = req.headers["x-twilio-signature"];
      const fullUrl = `${this.publicBase.replace(/^https:/, "wss:")}${url.pathname}${url.search}`;
      if (
        !validateTwilioSignature(
          this.deps.twilioAuthToken,
          typeof signature === "string" ? signature : undefined,
          fullUrl,
        )
      ) {
        return rejected(403, "Forbidden");
      }
      const callId = this.deps.service.store.getCallIdForRelayToken(match[1] as string);
      if (!callId) return rejected(404, "Not Found");
      const call = this.deps.service.store.getCall(callId);
      if (!call) return rejected(404, "Not Found");
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attachSession(ws, callId));
    });
  }

  private attachSession(ws: WebSocket, callId: string): void {
    const call = this.deps.service.store.getCall(callId);
    if (!call) {
      ws.close(1008, "unknown call");
      return;
    }
    const settings = effectiveCallSettings(this.deps.cfg, call.profile);
    new RelaySession(ws, call, this.deps.service, {
      llm: this.deps.llm,
      model: settings.model,
      fallbackModel: settings.fallbackModel,
      systemPrompt: settings.profile.systemPrompt,
      clock: this.deps.clock,
      metrics: this.deps.metrics,
    });
    logger.info("relay session attached", { callId });
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.publicBase);
    const path = url.pathname;
    if (req.method !== "POST" || (path !== "/twilio/status" && path !== "/twilio/recording")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const started = this.deps.clock.nowMs();
    const body = await readBody(req);
    const params = parseFormBody(body);
    const signature = req.headers["x-twilio-signature"];
    const fullUrl = `${this.publicBase}${path}${url.search}`;
    if (
      !validateTwilioSignature(
        this.deps.twilioAuthToken,
        typeof signature === "string" ? signature : undefined,
        fullUrl,
        params,
      )
    ) {
      this.deps.metrics.counter("voice_rejected_callbacks_total", "Signature failures").inc();
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      if (path === "/twilio/status") {
        this.deps.service.handleStatusCallback(params);
      } else {
        await this.deps.service.handleRecordingCallback(params);
      }
      this.deps.metrics
        .histogram("voice_callback_latency_ms", "Callback processing time")
        .observe(this.deps.clock.nowMs() - started);
      res.writeHead(204);
      res.end();
    } catch (err) {
      const status = (err as { httpStatus?: number }).httpStatus ?? 500;
      logger.warn("callback rejected", { path, status, error: (err as Error).message });
      res.writeHead(status);
      res.end();
    }
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, () => resolve()));
  }

  close(): Promise<void> {
    this.wss.close();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
