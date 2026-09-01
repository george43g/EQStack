/**
 * Admin REST boundary — negative-parse suite (Phase B steps 5 + 7) plus the
 * KEPT-VERBATIM (D-8) regression pins. Every D-31 coercion bug must now be a
 * 400 with a Zod issue path AND leave no state behind; the transport concerns
 * that survived the inversion (long-poll listener cleanup, SSE redaction,
 * 256KB body cap, CallServiceError→httpStatus mapping) are pinned here; the
 * D-28 redaction asymmetry fix (poll batch / per-call events / transcript)
 * is pinned with an injected full E.164 number.
 * No network, no paid calls: fake telephony + scripted LLM.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminClient } from "../src/client/admin-client.js";
import type { Config } from "../src/config/schema.js";
import { type Gateway, startGateway } from "../src/gateway/gateway.js";
import {
  FakeSecrets,
  FakeTelephony,
  fakeSecretValues,
  MemoryRecordingStore,
  ScriptedLlm,
  tempStateDir,
  testConfig,
} from "./helpers.js";

const PUBLIC_PORT = 18990;
const ADMIN_PORT = 18991;

let cfg: Config;
let gateway: Gateway;
let telephony: FakeTelephony;
let admin: AdminClient;
let stateDir: string;
let callId: string;
let providerCallId: string;

function adminUrl(path: string): string {
  return `http://127.0.0.1:${ADMIN_PORT}${path}`;
}

async function send(
  method: "POST" | "DELETE",
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(adminUrl(path), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Ground truth straight from the state DB — proves a rejected call wrote nothing. */
function countRows(table: "call_requests" | "calls"): number {
  const db = new DatabaseSync(join(stateDir, "telephony-mcp.sqlite3"), { readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

/** Incremental SSE reader that never drops a raced-out chunk. */
class SseCollector {
  buffer = "";
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | null = null;

  constructor(res: Response) {
    this.reader = (res.body as ReadableStream<Uint8Array>).getReader();
  }

  async waitFor(pred: (buffer: string) => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this.buffer)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting on SSE; buffer so far: ${this.buffer}`);
      }
      if (!this.pending) this.pending = this.reader.read();
      const result = await Promise.race([
        this.pending.then((r) => ({ r })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
      ]);
      if (result) {
        this.pending = null;
        if (result.r.done) throw new Error("SSE stream closed early");
        if (result.r.value) this.buffer += this.decoder.decode(result.r.value, { stream: true });
      }
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

beforeAll(async () => {
  stateDir = tempStateDir();
  cfg = testConfig({
    server: {
      publicBaseUrl: "https://gw.test.invalid",
      publicPort: PUBLIC_PORT,
      adminPort: ADMIN_PORT,
    },
  });
  telephony = new FakeTelephony();
  gateway = await startGateway(cfg, {
    secrets: new FakeSecrets(fakeSecretValues()),
    telephony,
    llm: new ScriptedLlm([]),
    recordings: new MemoryRecordingStore(),
  });
  admin = new AdminClient(ADMIN_PORT);
});

afterAll(async () => {
  await gateway.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("POST /requests — prepare_call schema (D-31 bugs 1 + 2)", () => {
  it("missing objective is a 400 with the Zod issue path, and no request is created", async () => {
    const before = countRows("call_requests");
    const { status, body } = await send("POST", "/requests", { recipient: "george" });
    expect(status).toBe(400);
    expect(body.error).toBe("objective: Required");
    expect(countRows("call_requests")).toBe(before);
  });

  it("empty objective is a 400 (was: silently created with objective '')", async () => {
    const before = countRows("call_requests");
    const { status, body } = await send("POST", "/requests", {
      recipient: "george",
      objective: "",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("objective: String must contain at least 1 character(s)");
    expect(countRows("call_requests")).toBe(before);
  });

  it('record:"false" is a 400 (was: Boolean("false") === true turned recording ON)', async () => {
    const before = countRows("call_requests");
    const { status, body } = await send("POST", "/requests", {
      recipient: "george",
      objective: "probe record coercion",
      record: "false",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("record: Expected boolean, received string");
    expect(countRows("call_requests")).toBe(before);
  });

  it("an unknown mode is a 400 with the enum issue", async () => {
    const { status, body } = await send("POST", "/requests", {
      recipient: "george",
      objective: "probe mode",
      mode: "walkie-talkie",
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/^mode: Invalid enum value/);
  });
});

describe("POST /calls — start_call confirm gate", () => {
  it("anything but the literal true is a 400: no dial, no call row", async () => {
    const { request } = await admin.prepare({ recipient: "george", objective: "confirm gate" });
    const before = countRows("calls");
    for (const confirm of ["true", 1, false, null]) {
      const { status, body } = await send("POST", "/calls", { requestId: request.id, confirm });
      expect(status, JSON.stringify(confirm)).toBe(400);
      expect(String(body.error)).toContain("confirm");
    }
    expect(countRows("calls")).toBe(before);
    expect(telephony.log.calls).toHaveLength(0);
  });
});

describe("mutating routes on a live call", () => {
  it("dials the suite's one allowed call (the schemas still admit valid input)", async () => {
    const { request } = await admin.prepare({
      recipient: "george",
      objective: "negative-path probe",
    });
    const { call } = await admin.start(request.id, true);
    callId = call.id;
    providerCallId = call.providerCallId as string;
    expect(call.recordingEnabled).toBe(true); // preconsented default
    expect(telephony.log.calls).toHaveLength(1);
  });

  it('end: a non-string reason is a 400 and the call stays up (was: "[object Object]")', async () => {
    const { status, body } = await send("POST", `/calls/${callId}/end`, {
      reason: { note: "object" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("reason: Expected string, received object");
    expect(telephony.log.ended).toHaveLength(0);
    expect((await admin.getCall(callId)).call.status).not.toBe("completed");
  });

  it("say: empty and >2000-char text are schema 400s; valid text still maps CallServiceError → HTTP 409 (kept verbatim)", async () => {
    const empty = await send("POST", `/calls/${callId}/say`, { text: "" });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("text: String must contain at least 1 character(s)");

    const oversize = await send("POST", `/calls/${callId}/say`, { text: "x".repeat(2001) });
    expect(oversize.status).toBe(400);
    expect(oversize.body.error).toBe("text: String must contain at most 2000 character(s)");

    // No relay session is attached → the service throws CallServiceError(…, 409).
    const valid = await send("POST", `/calls/${callId}/say`, { text: "anyone there?" });
    expect(valid.status).toBe(409);
    expect(String(valid.body.error)).toMatch(/no live session/);
  });

  it('recording: {"enabled":"false"} is a 400 and recording state is untouched', async () => {
    const before = (await admin.getCall(callId)).call.recordingEnabled;
    const { status, body } = await send("POST", `/calls/${callId}/recording`, {
      enabled: "false",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("enabled: Expected boolean, received string");
    expect((await admin.getCall(callId)).call.recordingEnabled).toBe(before);
    expect(telephony.log.recordingStarts).toHaveLength(0);
    expect(telephony.log.recordingStops).toHaveLength(0);
  });

  it("delete recording: bad scope and non-literal confirm are 400s; nothing is deleted", async () => {
    const badScope = await send("DELETE", "/recordings/REneg0001", {
      scope: "everything",
      confirm: true,
    });
    expect(badScope.status).toBe(400);
    expect(String(badScope.body.error)).toMatch(/^scope: Invalid enum value/);

    const badConfirm = await send("DELETE", "/recordings/REneg0001", {
      scope: "both",
      confirm: "yes",
    });
    expect(badConfirm.status).toBe(400);
    expect(badConfirm.body.error).toBe("confirm: Invalid literal value, expected true");
    expect(telephony.log.deletedRecordings).toHaveLength(0);
  });
});

describe("query-string parsing — the beforeMs NaN-flow fix (D-31 bug 3)", () => {
  it("GET /calls?beforeMs=abc is a 400, not an empty 200", async () => {
    const res = await fetch(adminUrl("/calls?beforeMs=abc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("beforeMs: Expected number, received nan");
  });

  it("GET /calls?limit=abc is a 400; valid coerced values still list the call", async () => {
    expect((await fetch(adminUrl("/calls?limit=abc"))).status).toBe(400);
    const ok = await fetch(adminUrl(`/calls?limit=5&beforeMs=${Date.now() + 60_000}`));
    expect(ok.status).toBe(200);
    const { calls } = (await ok.json()) as { calls: Array<{ id: string }> };
    expect(calls.some((c) => c.id === callId)).toBe(true);
  });

  it("GET /calls/:id/events rejects non-numeric afterSeq / limit / waitMs", async () => {
    for (const q of ["afterSeq=abc", "limit=abc", "waitMs=abc"]) {
      const res = await fetch(adminUrl(`/calls/${callId}/events?${q}`));
      expect(res.status, q).toBe(400);
      await res.json();
    }
  });

  it("waitMs keeps its clamp semantics — out-of-range numbers degrade, they don't 400", async () => {
    // Events exist at afterSeq 0, so the (clamped) wait never engages.
    const res = await fetch(adminUrl(`/calls/${callId}/events?waitMs=99999`));
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as { events: unknown[] };
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("KEPT VERBATIM (D-8) + D-28 redaction", () => {
  it("N sequential long-polls leave the event listener count unchanged", async () => {
    const baseline = gateway.service.events.listenerCount("event");
    for (let i = 0; i < 5; i++) {
      const res = await fetch(adminUrl(`/calls/${callId}/events?afterSeq=99999&waitMs=40`));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { events: unknown[] }).events).toEqual([]);
    }
    // One more, resolved by a live event rather than the timeout.
    const pending = fetch(adminUrl(`/calls/${callId}/events?afterSeq=99999&waitMs=5000`));
    setTimeout(() => gateway.service.emit(callId, "test.longpoll", { n: 1 }), 50);
    expect((await pending).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(gateway.service.events.listenerCount("event")).toBe(baseline);
  });

  it("SSE frames are redacted on both the backlog and the live path (INV-11)", async () => {
    gateway.service.emit(callId, "test.sse", {
      text: "call me back on +61455566777",
      marker: "sse-backlog-marker",
    });
    const ctrl = new AbortController();
    const res = await fetch(adminUrl("/events"), { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const sse = new SseCollector(res);
    try {
      await sse.waitFor((b) => b.includes("sse-backlog-marker"));
      gateway.service.emit(callId, "test.sse", {
        text: "or on +61455577888",
        marker: "sse-live-marker",
      });
      await sse.waitFor((b) => b.includes("sse-live-marker"));
    } finally {
      ctrl.abort();
      await sse.close();
    }
    expect(sse.buffer).not.toContain("+61455566777"); // backlog frame
    expect(sse.buffer).not.toContain("+61455577888"); // live frame
    expect(sse.buffer).toContain("…6777");
    expect(sse.buffer).toContain("…7888");
    await new Promise((r) => setTimeout(r, 50)); // let the close listener detach
  });

  it("D-28: the poll batch, per-call events, and transcript are redacted too", async () => {
    gateway.service.emit(callId, "test.redaction", { text: "raw number +61455599000 present" });
    gateway.service.store.addUtterance({
      callId,
      turn: 999,
      role: "user",
      text: "digits +61455599000",
      tsMs: Date.now(),
      interrupted: false,
    });
    const poll = await (await fetch(adminUrl("/events?poll=1&after=0"))).text();
    const events = await (await fetch(adminUrl(`/calls/${callId}/events`))).text();
    const transcript = await (await fetch(adminUrl(`/calls/${callId}/transcript`))).text();
    for (const [name, text] of [
      ["poll batch", poll],
      ["per-call events", events],
      ["transcript", transcript],
    ] as const) {
      expect(text, name).not.toContain("+61455599000");
      expect(text, name).toContain("…9000");
    }
  });

  it("a >256KB body is rejected before JSON.parse runs", async () => {
    const before = countRows("call_requests");
    // Valid prepare input — had it been parsed and dispatched, a request would exist.
    const body = JSON.stringify({
      recipient: "george",
      objective: "big-body probe",
      context: "x".repeat(300 * 1024),
    });
    let status: number | null = null;
    try {
      const res = await fetch(adminUrl("/requests"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      status = res.status;
    } catch {
      // The cap destroys the socket mid-upload; a reset is also a rejection.
    }
    if (status !== null) expect(status).toBeGreaterThanOrEqual(400);
    expect(countRows("call_requests")).toBe(before);
  });

  it("ends the suite's call cleanly through the routed command", async () => {
    const { status, body } = await send("POST", `/calls/${callId}/end`, {
      reason: "suite_complete",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(telephony.log.ended).toContain(providerCallId);
    expect((await admin.getCall(callId)).call.status).toBe("completed");
  });
});
