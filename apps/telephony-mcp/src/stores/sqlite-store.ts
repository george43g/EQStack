/**
 * node:sqlite persistence (WAL). One writer — the serve process; MCP/CLI
 * history readers open read-only. FTS5 indexes transcripts and sanitized
 * call metadata (alias/objective — never numbers, which the schema cannot
 * even represent beyond a suffix).
 */
import { DatabaseSync } from "node:sqlite";
import type { AgentProfileRecord, EventStore } from "../domain/ports.js";
import type {
  CallEvent,
  CallRecord,
  CallRequest,
  CallStatus,
  ConsultQuestion,
  ConsultStatus,
  RecordingMeta,
  TurnTiming,
  Utterance,
} from "../domain/types.js";
import { normalizeCallMode, TERMINAL_STATUSES } from "../domain/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS call_requests (
  id TEXT PRIMARY KEY,
  recipient_alias TEXT NOT NULL,
  number_suffix TEXT NOT NULL,
  objective TEXT NOT NULL,
  context TEXT,
  profile TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'llm',
  recording_enabled INTEGER NOT NULL,
  max_duration_sec INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  started_call_id TEXT
);
CREATE TABLE IF NOT EXISTS call_idempotency (
  key TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  provider_call_id TEXT UNIQUE,
  request_id TEXT NOT NULL,
  recipient_alias TEXT NOT NULL,
  number_suffix TEXT NOT NULL,
  profile TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  recording_enabled INTEGER NOT NULL,
  recording_policy TEXT NOT NULL,
  max_duration_sec INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  end_reason TEXT,
  phone_leg_sid TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (call_id, seq)
);
CREATE TABLE IF NOT EXISTS provider_events (
  call_id TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  PRIMARY KEY (call_id, provider_key)
);
CREATE TABLE IF NOT EXISTS utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS utterances_fts USING fts5(
  text, call_id UNINDEXED, utterance_id UNINDEXED
);
CREATE VIRTUAL TABLE IF NOT EXISTS calls_fts USING fts5(
  objective, recipient_alias, call_id UNINDEXED
);
CREATE TABLE IF NOT EXISTS recordings (
  provider_recording_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  duration_sec REAL,
  channels INTEGER NOT NULL DEFAULT 2,
  encrypted_path TEXT,
  size_bytes INTEGER,
  deleted_local INTEGER NOT NULL DEFAULT 0,
  deleted_provider INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS timings (
  call_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  end_of_turn_ms INTEGER,
  first_model_token_ms INTEGER,
  first_token_to_twilio_ms INTEGER,
  interrupted_at_ms INTEGER,
  delivered_to_host_ms INTEGER,
  reply_received_ms INTEGER,
  PRIMARY KEY (call_id, turn)
);
CREATE TABLE IF NOT EXISTS relay_tokens (
  token TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  brief_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
-- Phase R (consult). Additive: new tables only, created on every open, so a
-- live WAL database gains them on the next serve start with nothing rewritten.
-- Status transitions are guarded UPDATEs whose row count is the claim (D-60).
CREATE TABLE IF NOT EXISTS consult_questions (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  question TEXT NOT NULL,
  question_norm TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT,
  asked_at_ms INTEGER NOT NULL,
  first_delivered_ms INTEGER,
  answered_at_ms INTEGER,
  delivered_at_ms INTEGER,
  delivered_via TEXT,
  UNIQUE (call_id, seq)
);
-- The per-call consult bearer, as a SHA-256 hash only; deleted when the call ends.
CREATE TABLE IF NOT EXISTS consult_tokens (
  call_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consult_call ON consult_questions (call_id, status);
CREATE INDEX IF NOT EXISTS idx_events_call ON events (call_id, seq);
CREATE INDEX IF NOT EXISTS idx_calls_created ON calls (created_at_ms);
`;

interface CallRow {
  id: string;
  provider_call_id: string | null;
  request_id: string;
  recipient_alias: string;
  number_suffix: string;
  profile: string;
  objective: string;
  status: string;
  recording_enabled: number;
  recording_policy: string;
  max_duration_sec: number;
  created_at_ms: number;
  updated_at_ms: number;
  ended_at_ms: number | null;
  end_reason: string | null;
}

function rowToCall(r: CallRow): CallRecord {
  return {
    id: r.id,
    providerCallId: r.provider_call_id,
    requestId: r.request_id,
    recipientAlias: r.recipient_alias,
    numberSuffix: r.number_suffix,
    profile: r.profile,
    objective: r.objective,
    status: r.status as CallStatus,
    recordingEnabled: r.recording_enabled === 1,
    recordingPolicy: r.recording_policy as CallRecord["recordingPolicy"],
    maxDurationSec: r.max_duration_sec,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
    endedAtMs: r.ended_at_ms,
    endReason: r.end_reason,
  };
}

function rowToConsult(r: Record<string, unknown>): ConsultQuestion {
  return {
    id: r.id as string,
    callId: r.call_id as string,
    seq: r.seq as number,
    question: r.question as string,
    status: r.status as ConsultStatus,
    answer: (r.answer as string | null) ?? null,
    askedAtMs: r.asked_at_ms as number,
    firstDeliveredMs: (r.first_delivered_ms as number | null) ?? null,
    answeredAtMs: (r.answered_at_ms as number | null) ?? null,
    deliveredAtMs: (r.delivered_at_ms as number | null) ?? null,
    deliveredVia: (r.delivered_via as string | null) ?? null,
  };
}

export class SqliteStore implements EventStore {
  private db: DatabaseSync;
  readonly readonly: boolean;

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    this.readonly = opts.readonly ?? false;
    this.db = new DatabaseSync(path, { readOnly: this.readonly });
    if (!this.readonly) {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec(SCHEMA);
      this.migrate();
    }
  }

  /** Additive column migrations for databases created by earlier schemas. */
  private migrate(): void {
    try {
      this.db.exec("ALTER TABLE call_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'llm'");
    } catch {
      // column already exists
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS call_idempotency (key TEXT PRIMARY KEY, call_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL)",
    );
    // O-30: the carrier's id for a delegate call's phone leg. Nullable, no
    // default, no index — additive and instant on a live WAL database.
    try {
      this.db.exec("ALTER TABLE calls ADD COLUMN phone_leg_sid TEXT");
    } catch {
      // column already exists
    }
    for (const col of ["delivered_to_host_ms", "reply_received_ms"]) {
      try {
        this.db.exec(`ALTER TABLE timings ADD COLUMN ${col} INTEGER`);
      } catch {
        // column already exists
      }
    }
  }

  // -- call requests --------------------------------------------------------

  createCallRequest(req: CallRequest): void {
    this.db
      .prepare(
        `INSERT INTO call_requests (id, recipient_alias, number_suffix, objective, context,
           profile, mode, recording_enabled, max_duration_sec, created_at_ms, expires_at_ms, started_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.id,
        req.recipientAlias,
        req.numberSuffix,
        req.objective,
        req.context,
        req.profile,
        req.mode,
        req.recordingEnabled ? 1 : 0,
        req.maxDurationSec,
        req.createdAtMs,
        0, // expires_at_ms retired in Phase C (D-5); column kept, additive-migration style
        req.startedCallId,
      );
  }

  getCallRequest(id: string): CallRequest | null {
    const r = this.db.prepare("SELECT * FROM call_requests WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      recipientAlias: r.recipient_alias as string,
      numberSuffix: r.number_suffix as string,
      objective: r.objective as string,
      context: (r.context as string | null) ?? null,
      profile: r.profile as string,
      mode: normalizeCallMode(r.mode),
      recordingEnabled: r.recording_enabled === 1,
      maxDurationSec: r.max_duration_sec as number,
      createdAtMs: r.created_at_ms as number,
      startedCallId: (r.started_call_id as string | null) ?? null,
    };
  }

  markRequestStarted(id: string, callId: string): void {
    this.db.prepare("UPDATE call_requests SET started_call_id = ? WHERE id = ?").run(callId, id);
  }

  // -- calls ----------------------------------------------------------------

  createCall(call: CallRecord): void {
    this.db
      .prepare(
        `INSERT INTO calls (id, provider_call_id, request_id, recipient_alias, number_suffix,
           profile, objective, status, recording_enabled, recording_policy, max_duration_sec,
           created_at_ms, updated_at_ms, ended_at_ms, end_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.id,
        call.providerCallId,
        call.requestId,
        call.recipientAlias,
        call.numberSuffix,
        call.profile,
        call.objective,
        call.status,
        call.recordingEnabled ? 1 : 0,
        call.recordingPolicy,
        call.maxDurationSec,
        call.createdAtMs,
        call.updatedAtMs,
        call.endedAtMs,
        call.endReason,
      );
    this.db
      .prepare("INSERT INTO calls_fts (objective, recipient_alias, call_id) VALUES (?, ?, ?)")
      .run(call.objective, call.recipientAlias, call.id);
  }

  getCall(id: string): CallRecord | null {
    const r = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as CallRow | undefined;
    return r ? rowToCall(r) : null;
  }

  getCallByProviderId(providerCallId: string): CallRecord | null {
    const r = this.db
      .prepare("SELECT * FROM calls WHERE provider_call_id = ?")
      .get(providerCallId) as CallRow | undefined;
    return r ? rowToCall(r) : null;
  }

  setProviderCallId(id: string, providerCallId: string): void {
    this.db.prepare("UPDATE calls SET provider_call_id = ? WHERE id = ?").run(providerCallId, id);
  }

  setPhoneLegSid(id: string, phoneLegSid: string): void {
    this.db.prepare("UPDATE calls SET phone_leg_sid = ? WHERE id = ?").run(phoneLegSid, id);
  }

  getPhoneLegSid(id: string): string | null {
    const r = this.db.prepare("SELECT phone_leg_sid FROM calls WHERE id = ?").get(id) as
      | { phone_leg_sid: string | null }
      | undefined;
    return r?.phone_leg_sid ?? null;
  }

  updateCallStatus(
    id: string,
    status: CallStatus,
    opts: { endedAtMs?: number; endReason?: string } = {},
  ): void {
    this.db
      .prepare(
        "UPDATE calls SET status = ?, updated_at_ms = ?, ended_at_ms = COALESCE(?, ended_at_ms), end_reason = COALESCE(?, end_reason) WHERE id = ?",
      )
      .run(status, Date.now(), opts.endedAtMs ?? null, opts.endReason ?? null, id);
  }

  setRecordingEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare("UPDATE calls SET recording_enabled = ?, updated_at_ms = ? WHERE id = ?")
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  listCalls(opts: { limit?: number; beforeMs?: number; status?: CallStatus } = {}): CallRecord[] {
    const limit = Math.min(opts.limit ?? 20, 100);
    const beforeMs = opts.beforeMs ?? Number.MAX_SAFE_INTEGER;
    const rows = (opts.status
      ? this.db
          .prepare(
            "SELECT * FROM calls WHERE created_at_ms < ? AND status = ? ORDER BY created_at_ms DESC LIMIT ?",
          )
          .all(beforeMs, opts.status, limit)
      : this.db
          .prepare(
            "SELECT * FROM calls WHERE created_at_ms < ? ORDER BY created_at_ms DESC LIMIT ?",
          )
          .all(beforeMs, limit)) as unknown as CallRow[];
    return rows.map(rowToCall);
  }

  activeCallCount(): number {
    const terminal = [...TERMINAL_STATUSES];
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM calls WHERE status NOT IN (${terminal.map(() => "?").join(",")})`,
      )
      .get(...terminal) as { n: number };
    return r.n;
  }

  // -- events ---------------------------------------------------------------

  appendEvent(callId: string, type: string, data: Record<string, unknown>): CallEvent {
    const tsMs = Date.now();
    const next = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE call_id = ?")
      .get(callId) as { seq: number };
    const result = this.db
      .prepare("INSERT INTO events (call_id, seq, ts_ms, type, data) VALUES (?, ?, ?, ?, ?)")
      .run(callId, next.seq, tsMs, type, JSON.stringify(data));
    return { id: Number(result.lastInsertRowid), callId, seq: next.seq, tsMs, type, data };
  }

  getEvents(callId: string, afterSeq = 0, limit = 200): CallEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE call_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(callId, afterSeq, Math.min(limit, 500)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      callId: r.call_id as string,
      seq: r.seq as number,
      tsMs: r.ts_ms as number,
      type: r.type as string,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
    }));
  }

  getGlobalEvents(afterId = 0, limit = 200): CallEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?")
      .all(afterId, Math.min(limit, 500)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      callId: r.call_id as string,
      seq: r.seq as number,
      tsMs: r.ts_ms as number,
      type: r.type as string,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
    }));
  }

  /** Read-only dedupe lookup — runs BEFORE the concurrency check so an
   * idempotent retry of a LIVE call returns it instead of a 409. */
  lookupCallIdempotency(key: string, nowMs: number, windowMs: number): string | null {
    const r = this.db
      .prepare("SELECT call_id FROM call_idempotency WHERE key = ? AND created_at_ms > ?")
      .get(key, nowMs - windowMs) as { call_id: string } | undefined;
    return r?.call_id ?? null;
  }

  /**
   * One-shot dedupe claim (Phase C step 5). Insert-before-dial: a hit inside
   * the window returns the winner's callId and the caller MUST NOT dial.
   * Same insert / catch-UNIQUE shape as recordProviderEvent below.
   */
  claimCallIdempotency(
    key: string,
    callId: string,
    nowMs: number,
    windowMs: number,
  ): { claimed: true } | { claimed: false; existingCallId: string } {
    this.db.prepare("DELETE FROM call_idempotency WHERE created_at_ms <= ?").run(nowMs - windowMs);
    try {
      this.db
        .prepare("INSERT INTO call_idempotency (key, call_id, created_at_ms) VALUES (?, ?, ?)")
        .run(key, callId, nowMs);
      return { claimed: true };
    } catch {
      const r = this.db.prepare("SELECT call_id FROM call_idempotency WHERE key = ?").get(key) as
        | { call_id: string }
        | undefined;
      if (!r) {
        // pruned between our insert attempt and re-read — retry once
        this.db
          .prepare("INSERT INTO call_idempotency (key, call_id, created_at_ms) VALUES (?, ?, ?)")
          .run(key, callId, nowMs);
        return { claimed: true };
      }
      return { claimed: false, existingCallId: r.call_id };
    }
  }

  /** Release a claim whose dial failed, so an honest retry can ring again. */
  releaseCallIdempotency(key: string): void {
    this.db.prepare("DELETE FROM call_idempotency WHERE key = ?").run(key);
  }

  recordProviderEvent(callId: string, providerKey: string): boolean {
    try {
      this.db
        .prepare("INSERT INTO provider_events (call_id, provider_key, ts_ms) VALUES (?, ?, ?)")
        .run(callId, providerKey, Date.now());
      return true;
    } catch {
      return false; // UNIQUE violation → duplicate/replayed callback
    }
  }

  // -- utterances + search --------------------------------------------------

  addUtterance(u: Omit<Utterance, "id">): Utterance {
    const result = this.db
      .prepare(
        "INSERT INTO utterances (call_id, turn, role, text, ts_ms, interrupted) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(u.callId, u.turn, u.role, u.text, u.tsMs, u.interrupted ? 1 : 0);
    const id = Number(result.lastInsertRowid);
    this.db
      .prepare("INSERT INTO utterances_fts (text, call_id, utterance_id) VALUES (?, ?, ?)")
      .run(u.text, u.callId, id);
    return { ...u, id };
  }

  getTranscript(callId: string): Utterance[] {
    const rows = this.db
      .prepare("SELECT * FROM utterances WHERE call_id = ? ORDER BY id")
      .all(callId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      callId: r.call_id as string,
      turn: r.turn as number,
      role: r.role as Utterance["role"],
      text: r.text as string,
      tsMs: r.ts_ms as number,
      interrupted: r.interrupted === 1,
    }));
  }

  searchTranscripts(query: string, limit = 20): Array<Utterance & { callId: string }> {
    const rows = this.db
      .prepare(
        `SELECT u.* FROM utterances_fts f JOIN utterances u ON u.id = f.utterance_id
         WHERE utterances_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, Math.min(limit, 100)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      callId: r.call_id as string,
      turn: r.turn as number,
      role: r.role as Utterance["role"],
      text: r.text as string,
      tsMs: r.ts_ms as number,
      interrupted: r.interrupted === 1,
    }));
  }

  searchCalls(query: string, limit = 20): CallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM calls_fts f JOIN calls c ON c.id = f.call_id
         WHERE calls_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, Math.min(limit, 100)) as unknown as CallRow[];
    return rows.map(rowToCall);
  }

  // -- recordings -----------------------------------------------------------

  upsertRecording(meta: RecordingMeta): void {
    this.db
      .prepare(
        `INSERT INTO recordings (provider_recording_id, call_id, duration_sec, channels,
           encrypted_path, size_bytes, deleted_local, deleted_provider, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider_recording_id) DO UPDATE SET
           duration_sec = excluded.duration_sec,
           encrypted_path = excluded.encrypted_path,
           size_bytes = excluded.size_bytes`,
      )
      .run(
        meta.providerRecordingId,
        meta.callId,
        meta.durationSec,
        meta.channels,
        meta.encryptedPath,
        meta.sizeBytes,
        meta.deletedLocal ? 1 : 0,
        meta.deletedProvider ? 1 : 0,
        meta.createdAtMs,
      );
  }

  getRecording(providerRecordingId: string): RecordingMeta | null {
    const r = this.db
      .prepare("SELECT * FROM recordings WHERE provider_recording_id = ?")
      .get(providerRecordingId) as Record<string, unknown> | undefined;
    return r ? this.rowToRecording(r) : null;
  }

  getRecordingsForCall(callId: string): RecordingMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM recordings WHERE call_id = ? ORDER BY created_at_ms")
      .all(callId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToRecording(r));
  }

  markRecordingDeleted(providerRecordingId: string, scope: "local" | "provider"): void {
    const col = scope === "local" ? "deleted_local" : "deleted_provider";
    this.db
      .prepare(
        `UPDATE recordings SET ${col} = 1, encrypted_path = CASE WHEN ? = 'local' THEN NULL ELSE encrypted_path END WHERE provider_recording_id = ?`,
      )
      .run(scope, providerRecordingId);
  }

  private rowToRecording(r: Record<string, unknown>): RecordingMeta {
    return {
      providerRecordingId: r.provider_recording_id as string,
      callId: r.call_id as string,
      durationSec: (r.duration_sec as number | null) ?? null,
      channels: r.channels as number,
      encryptedPath: (r.encrypted_path as string | null) ?? null,
      sizeBytes: (r.size_bytes as number | null) ?? null,
      deletedLocal: r.deleted_local === 1,
      deletedProvider: r.deleted_provider === 1,
      createdAtMs: r.created_at_ms as number,
    };
  }

  // -- timings --------------------------------------------------------------

  upsertTiming(t: Pick<TurnTiming, "callId" | "turn"> & Partial<TurnTiming>): void {
    this.db
      .prepare(
        `INSERT INTO timings (call_id, turn, end_of_turn_ms, first_model_token_ms,
           first_token_to_twilio_ms, interrupted_at_ms, delivered_to_host_ms, reply_received_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (call_id, turn) DO UPDATE SET
           end_of_turn_ms = COALESCE(excluded.end_of_turn_ms, timings.end_of_turn_ms),
           first_model_token_ms = COALESCE(excluded.first_model_token_ms, timings.first_model_token_ms),
           first_token_to_twilio_ms = COALESCE(excluded.first_token_to_twilio_ms, timings.first_token_to_twilio_ms),
           interrupted_at_ms = COALESCE(excluded.interrupted_at_ms, timings.interrupted_at_ms),
           delivered_to_host_ms = COALESCE(excluded.delivered_to_host_ms, timings.delivered_to_host_ms),
           reply_received_ms = COALESCE(excluded.reply_received_ms, timings.reply_received_ms)`,
      )
      .run(
        t.callId,
        t.turn,
        t.endOfTurnMs ?? null,
        t.firstModelTokenMs ?? null,
        t.firstTokenToTwilioMs ?? null,
        t.interruptedAtMs ?? null,
        t.deliveredToHostMs ?? null,
        t.replyReceivedMs ?? null,
      );
  }

  /**
   * First-write-wins pickup stamp (Phase E). upsertTiming's
   * COALESCE(excluded, existing) is last-write-wins for an ALWAYS-non-null
   * value, so a re-poll would move it; this conditional UPDATE only sets the
   * column while it is still null, atomically.
   */
  stampDeliveredIfUnset(callId: string, turn: number, ms: number): void {
    this.db
      .prepare(
        `UPDATE timings SET delivered_to_host_ms = ?
         WHERE call_id = ? AND turn = ? AND delivered_to_host_ms IS NULL`,
      )
      .run(ms, callId, turn);
  }

  getTimings(callId: string): TurnTiming[] {
    const rows = this.db
      .prepare("SELECT * FROM timings WHERE call_id = ? ORDER BY turn")
      .all(callId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      callId: r.call_id as string,
      turn: r.turn as number,
      endOfTurnMs: (r.end_of_turn_ms as number | null) ?? null,
      firstModelTokenMs: (r.first_model_token_ms as number | null) ?? null,
      firstTokenToTwilioMs: (r.first_token_to_twilio_ms as number | null) ?? null,
      interruptedAtMs: (r.interrupted_at_ms as number | null) ?? null,
      deliveredToHostMs: (r.delivered_to_host_ms as number | null) ?? null,
      replyReceivedMs: (r.reply_received_ms as number | null) ?? null,
    }));
  }

  // -- agent profiles (Phase Q) ----------------------------------------------

  getAgentProfile(agentKey: string): AgentProfileRecord | null {
    const r = this.db.prepare("SELECT * FROM agent_profiles WHERE agent_key = ?").get(agentKey) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      agentKey: r.agent_key as string,
      agentId: r.agent_id as string,
      briefHash: r.brief_hash as string,
      updatedAtMs: r.updated_at_ms as number,
    };
  }

  upsertAgentProfile(record: AgentProfileRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_profiles (agent_key, agent_id, brief_hash, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (agent_key) DO UPDATE SET
           agent_id = excluded.agent_id,
           brief_hash = excluded.brief_hash,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(record.agentKey, record.agentId, record.briefHash, record.updatedAtMs);
  }

  // -- consult (Phase R) ----------------------------------------------------

  /** Inserts a question with the next per-call seq; returns the stored row. */
  insertConsultQuestion(q: {
    id: string;
    callId: string;
    question: string;
    questionNorm: string;
    status: ConsultStatus;
    askedAtMs: number;
  }): ConsultQuestion {
    const next = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM consult_questions WHERE call_id = ?")
      .get(q.callId) as { seq: number };
    this.db
      .prepare(
        `INSERT INTO consult_questions (id, call_id, seq, question, question_norm, status, asked_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(q.id, q.callId, next.seq, q.question, q.questionNorm, q.status, q.askedAtMs);
    return this.getConsultQuestion(q.callId, q.id) as ConsultQuestion;
  }

  /** Scoped to one call: another call's question id is indistinguishable from none. */
  getConsultQuestion(callId: string, id: string): ConsultQuestion | null {
    const r = this.db
      .prepare("SELECT * FROM consult_questions WHERE call_id = ? AND id = ?")
      .get(callId, id) as Record<string, unknown> | undefined;
    return r ? rowToConsult(r) : null;
  }

  findPendingConsultByNorm(callId: string, questionNorm: string): ConsultQuestion | null {
    const r = this.db
      .prepare(
        "SELECT * FROM consult_questions WHERE call_id = ? AND status = 'pending' AND question_norm = ? ORDER BY seq LIMIT 1",
      )
      .get(callId, questionNorm) as Record<string, unknown> | undefined;
    return r ? rowToConsult(r) : null;
  }

  countPendingConsults(callId: string): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM consult_questions WHERE call_id = ? AND status = 'pending'",
      )
      .get(callId) as { n: number };
    return r.n;
  }

  listConsultQuestions(callId: string): ConsultQuestion[] {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = this.db
        .prepare("SELECT * FROM consult_questions WHERE call_id = ? ORDER BY seq")
        .all(callId) as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      // A read-only reader (MCP/CLI) can meet a DB a pre-Phase-R serve still
      // owns: only serve creates tables, so "no table" means "no questions".
      if (this.readonly && /no such table/.test((err as Error).message)) return [];
      throw err;
    }
    return rows.map(rowToConsult);
  }

  /**
   * A guarded transition: moves the row only while it is still in `from`.
   * The returned boolean IS the claim — exactly one caller wins (D-60 pattern).
   */
  transitionConsult(
    callId: string,
    id: string,
    from: ConsultStatus,
    to: ConsultStatus,
    set: {
      answer?: string;
      answeredAtMs?: number;
      deliveredAtMs?: number;
      deliveredVia?: string;
    } = {},
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE consult_questions SET status = ?,
           answer = COALESCE(?, answer),
           answered_at_ms = COALESCE(?, answered_at_ms),
           delivered_at_ms = COALESCE(?, delivered_at_ms),
           delivered_via = COALESCE(?, delivered_via)
         WHERE call_id = ? AND id = ? AND status = ?`,
      )
      .run(
        to,
        set.answer ?? null,
        set.answeredAtMs ?? null,
        set.deliveredAtMs ?? null,
        set.deliveredVia ?? null,
        callId,
        id,
        from,
      );
    return Number(result.changes) === 1;
  }

  /** consult.pickup: first delivery of consult.asked to a polling host wins. */
  stampConsultPickupIfUnset(callId: string, id: string, ms: number): void {
    this.db
      .prepare(
        `UPDATE consult_questions SET first_delivered_ms = ?
         WHERE call_id = ? AND id = ? AND first_delivered_ms IS NULL`,
      )
      .run(ms, callId, id);
  }

  /** Every still-pending question on the call → cancelled. Returns the ids moved. */
  cancelPendingConsults(callId: string): string[] {
    const ids = (
      this.db
        .prepare("SELECT id FROM consult_questions WHERE call_id = ? AND status = 'pending'")
        .all(callId) as unknown as Array<{ id: string }>
    ).map((r) => r.id);
    return ids.filter((id) => this.transitionConsult(callId, id, "pending", "cancelled"));
  }

  putConsultTokenHash(callId: string, tokenHash: string, nowMs: number): void {
    this.db
      .prepare("INSERT INTO consult_tokens (call_id, token_hash, created_at_ms) VALUES (?, ?, ?)")
      .run(callId, tokenHash, nowMs);
  }

  /** Lookup keyed on the hash — the token itself is never stored or compared. */
  getCallIdForConsultTokenHash(tokenHash: string): string | null {
    const r = this.db
      .prepare("SELECT call_id FROM consult_tokens WHERE token_hash = ?")
      .get(tokenHash) as { call_id: string } | undefined;
    return r?.call_id ?? null;
  }

  hasConsultToken(callId: string): boolean {
    return (
      this.db.prepare("SELECT 1 AS x FROM consult_tokens WHERE call_id = ?").get(callId) !==
      undefined
    );
  }

  deleteConsultToken(callId: string): void {
    this.db.prepare("DELETE FROM consult_tokens WHERE call_id = ?").run(callId);
  }

  /** Calls that are already terminal but still hold consult state (a crash between the two). */
  terminalCallsWithConsultState(): string[] {
    const terminal = [...TERMINAL_STATUSES];
    const marks = terminal.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id FROM calls WHERE status IN (${marks}) AND (
           id IN (SELECT call_id FROM consult_tokens)
           OR id IN (SELECT call_id FROM consult_questions WHERE status = 'pending'))`,
      )
      .all(...terminal) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  // -- relay tokens ---------------------------------------------------------

  putRelayToken(token: string, callId: string): void {
    this.db
      .prepare("INSERT INTO relay_tokens (token, call_id, created_at_ms) VALUES (?, ?, ?)")
      .run(token, callId, Date.now());
  }

  getCallIdForRelayToken(token: string): string | null {
    const r = this.db.prepare("SELECT call_id FROM relay_tokens WHERE token = ?").get(token) as
      | { call_id: string }
      | undefined;
    return r?.call_id ?? null;
  }

  getRelayTokenForCall(callId: string): string | null {
    const r = this.db.prepare("SELECT token FROM relay_tokens WHERE call_id = ?").get(callId) as
      | { token: string }
      | undefined;
    return r?.token ?? null;
  }

  close(): void {
    this.db.close();
  }
}
