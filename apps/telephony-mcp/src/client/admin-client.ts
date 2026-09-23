/**
 * Thin client for the localhost admin API — the ONLY mutation path for the
 * MCP server and CLI. A refused connection means the gateway isn't running,
 * which is a first-class, user-fixable condition.
 */
import type { CallEvent, CallRecord, Utterance } from "../domain/types.js";

export class GatewayUnavailableError extends Error {
  constructor(adminPort: number) {
    super(
      `telephony-mcp gateway is not running (nothing listening on 127.0.0.1:${adminPort}) — start it with \`tel serve\``,
    );
  }
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class AdminClient {
  private base: string;

  constructor(
    private adminPort: number,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `http://127.0.0.1:${adminPort}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        ...(body !== undefined
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
    } catch {
      throw new GatewayUnavailableError(this.adminPort);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      throw new AdminApiError(res.status, String(json.error ?? `admin API HTTP ${res.status}`));
    }
    return json as T;
  }

  health(): Promise<{ ok: boolean; version: string; activeCalls: number }> {
    return this.request("GET", "/healthz");
  }

  placeCall(input: {
    to: string;
    objective: string;
    context?: string | undefined;
    profile?: string | undefined;
    record?: boolean | undefined;
    mode?: import("../domain/types.js").CallMode | undefined;
    acknowledgeThirdPartyRecording?: boolean | undefined;
    dryRun?: boolean | undefined;
    idempotencyKey?: string | undefined;
  }): Promise<import("../gateway/call-service.js").PlaceCallResult> {
    return this.request("POST", "/calls", input);
  }

  startMeeting(
    input: import("../gateway/call-service.js").StartMeetingInput,
  ): Promise<import("../gateway/call-service.js").StartMeetingResult> {
    return this.request("POST", "/meetings", input);
  }

  endCall(callId: string, reason?: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/calls/${callId}/end`, { reason });
  }

  playDisclosure(callId: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/calls/${callId}/disclosure`, {});
  }

  say(callId: string, text: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/calls/${callId}/say`, { text });
  }

  setRecording(callId: string, enabled: boolean): Promise<{ ok: boolean }> {
    return this.request("POST", `/calls/${callId}/recording`, { enabled });
  }

  deleteRecording(
    recordingSid: string,
    scope: "local" | "provider" | "both",
    confirm: boolean,
  ): Promise<{ deletedLocal: boolean; deletedProvider: boolean }> {
    return this.request("DELETE", `/recordings/${recordingSid}`, { scope, confirm });
  }

  answerConsult(
    callId: string,
    questionId: string,
    answer: string,
  ): Promise<{ status: "answered"; delivered: boolean; collectable: boolean }> {
    return this.request(
      "POST",
      `/calls/${encodeURIComponent(callId)}/consult/${encodeURIComponent(questionId)}/answer`,
      { answer },
    );
  }

  listCalls(opts: { limit?: number; beforeMs?: number } = {}): Promise<{ calls: CallRecord[] }> {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.beforeMs) q.set("beforeMs", String(opts.beforeMs));
    const qs = q.toString();
    return this.request("GET", `/calls${qs ? `?${qs}` : ""}`);
  }

  getCall(callId: string): Promise<{ call: CallRecord }> {
    return this.request("GET", `/calls/${callId}`);
  }

  /**
   * `nextCursor` is the last event the gateway READ; with `as` (a meeting
   * member) it can be past the last event returned, because other members'
   * questions are filtered out (PHASE-GC § 3).
   */
  getEvents(
    callId: string,
    afterSeq = 0,
    limit = 200,
    waitMs = 0,
    as?: string,
  ): Promise<{ events: CallEvent[]; nextCursor?: number }> {
    const wait = waitMs > 0 ? `&waitMs=${waitMs}` : "";
    const member = as !== undefined ? `&as=${encodeURIComponent(as)}` : "";
    return this.request(
      "GET",
      `/calls/${callId}/events?afterSeq=${afterSeq}&limit=${limit}${wait}${member}`,
    );
  }

  getTranscript(callId: string): Promise<{ transcript: Utterance[] }> {
    return this.request("GET", `/calls/${callId}/transcript`);
  }

  pollGlobalEvents(afterId = 0): Promise<{ events: CallEvent[] }> {
    return this.request("GET", `/events?poll=1&after=${afterId}`);
  }
}
