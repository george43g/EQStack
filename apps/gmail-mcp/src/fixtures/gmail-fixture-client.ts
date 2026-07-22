// Fake gmail client backed by per-account JSON fixtures on disk. Built to
// satisfy the methods src/core/ops/*.ts actually call:
//
//   gmail.users.getProfile
//   gmail.users.messages.{get, list, modify, batchModify, delete, send}
//   gmail.users.messages.attachments.get
//   gmail.users.threads.{get, list, modify}
//   gmail.users.drafts.{create, update, send, delete}
//   gmail.users.labels.{get, list, create, update, delete}
//   gmail.users.settings.filters.{get, list, create, delete}
//
// Read paths return validated fixture data. Mutating paths return canned
// success envelopes without persisting (e2e tests assert call shape, not
// state mutation against the fixture corpus).
//
// Cast site: `bootstrapSession` casts the constructed client as `gmail_v1.
// Gmail` so the existing ops type-check unchanged. Each tested method is
// implemented; calling an unimplemented method throws a clear error so the
// gap is visible immediately.

import fs from "node:fs";
import path from "node:path";
import {
  AttachmentBodySchema,
  FilterSchema,
  LabelSchema,
  ListFiltersResponseSchema,
  ListLabelsResponseSchema,
  ListMessagesResponseSchema,
  ListThreadsResponseSchema,
  MessageSchema,
  ProfileSchema,
  ThreadSchema,
} from "./gmail-schemas.js";

interface RestResponse<T> {
  data: T;
}

interface ListRequestParams {
  userId?: string;
  q?: string;
  maxResults?: number;
  labelIds?: string[];
}

export class GmailFixtureClient {
  constructor(
    public readonly accountDir: string,
    private readonly latencyMs = 0,
  ) {}

  private async waitForLatency(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
  }

  // ── messages.* ──────────────────────────────────────────────────────────

  users = {
    getProfile: async (_params: { userId: string }): Promise<RestResponse<unknown>> => {
      const raw = this.readJson("profile.json");
      const data = ProfileSchema.parse(raw);
      return { data };
    },

    messages: {
      get: async (params: {
        userId: string;
        id: string;
        format?: string;
      }): Promise<RestResponse<unknown>> => {
        const raw = this.readJson(path.join("messages", `${params.id}.json`));
        const data = MessageSchema.parse(raw);
        return { data };
      },

      list: async (params: ListRequestParams): Promise<RestResponse<unknown>> => {
        const messages = this.listAllMessages();
        const filtered = this.filterByQuery(messages, params.q, params.labelIds);
        const limit = params.maxResults ?? filtered.length;
        const trimmed = filtered.slice(0, limit);
        return {
          data: ListMessagesResponseSchema.parse({
            messages: trimmed.map((m) => ({ id: m.id!, threadId: m.threadId })),
            resultSizeEstimate: filtered.length,
          }),
        };
      },

      modify: async (_params: {
        userId: string;
        id: string;
        requestBody?: { addLabelIds?: string[]; removeLabelIds?: string[] };
      }): Promise<RestResponse<unknown>> => {
        // Canned success; return a stub Message envelope.
        return { data: { id: _params.id, threadId: "fixture-thread", labelIds: [] } };
      },

      batchModify: async (_params: {
        userId: string;
        requestBody?: { ids?: string[]; addLabelIds?: string[]; removeLabelIds?: string[] };
      }): Promise<RestResponse<unknown>> => ({ data: {} }),

      delete: async (_params: { userId: string; id: string }): Promise<RestResponse<unknown>> => {
        return { data: {} };
      },

      send: async (params: {
        userId: string;
        requestBody?: { raw?: string; threadId?: string };
      }): Promise<RestResponse<unknown>> => {
        return {
          data: {
            id: `fixture-sent-${Date.now()}`,
            threadId: params.requestBody?.threadId ?? `fixture-thread-${Date.now()}`,
            labelIds: ["SENT"],
          },
        };
      },

      attachments: {
        get: async (params: {
          userId: string;
          messageId: string;
          id: string;
        }): Promise<RestResponse<unknown>> => {
          const raw = this.readJson(
            path.join("attachments", `${params.messageId}-${params.id}.json`),
          );
          return { data: AttachmentBodySchema.parse(raw) };
        },
      },
    },

    threads: {
      get: async (params: {
        userId: string;
        id: string;
        format?: string;
      }): Promise<RestResponse<unknown>> => {
        const raw = this.readJson(path.join("threads", `${params.id}.json`));
        return { data: ThreadSchema.parse(raw) };
      },

      list: async (params: ListRequestParams): Promise<RestResponse<unknown>> => {
        const threads = this.listAllThreads();
        const filtered = this.filterThreadsByQuery(threads, params.q);
        const limit = params.maxResults ?? filtered.length;
        const trimmed = filtered.slice(0, limit);
        return {
          data: ListThreadsResponseSchema.parse({
            threads: trimmed.map((t) => ({
              id: t.id!,
              historyId: t.historyId,
              snippet: t.snippet,
            })),
            resultSizeEstimate: filtered.length,
          }),
        };
      },

      modify: async (params: {
        userId: string;
        id: string;
        requestBody?: { addLabelIds?: string[]; removeLabelIds?: string[] };
      }): Promise<RestResponse<unknown>> => {
        return { data: { id: params.id } };
      },
    },

    drafts: {
      create: async (_params: {
        userId: string;
        requestBody?: { message?: { raw?: string; threadId?: string } };
      }): Promise<RestResponse<unknown>> => {
        return {
          data: {
            id: `fixture-draft-${Date.now()}`,
            message: { id: `fixture-msg-${Date.now()}` },
          },
        };
      },
      update: async (params: {
        userId: string;
        id: string;
        requestBody?: { message?: { raw?: string; threadId?: string } };
      }): Promise<RestResponse<unknown>> => ({
        data: {
          id: params.id,
          message: {
            id: `fixture-msg-${Date.now()}`,
            threadId: params.requestBody?.message?.threadId ?? "fixture-thread",
          },
        },
      }),
      send: async (params: {
        userId: string;
        requestBody?: { id?: string };
      }): Promise<RestResponse<unknown>> => ({
        data: {
          id: `fixture-sent-${params.requestBody?.id ?? Date.now()}`,
          threadId: "fixture-thread",
          labelIds: ["SENT"],
        },
      }),
      delete: async (_params: { userId: string; id: string }): Promise<RestResponse<unknown>> => ({
        data: {},
      }),
    },

    labels: {
      get: async (params: { userId: string; id: string }): Promise<RestResponse<unknown>> => {
        const labels = this.readLabels();
        const label = labels.find((l) => l.id === params.id);
        if (!label) {
          const err = new Error(`label ${params.id} not found`) as Error & { code: number };
          err.code = 404;
          throw err;
        }
        return { data: LabelSchema.parse(label) };
      },

      list: async (_params: { userId: string }): Promise<RestResponse<unknown>> => {
        await this.waitForLatency();
        const labels = this.readLabels();
        return { data: ListLabelsResponseSchema.parse({ labels }) };
      },

      create: async (params: {
        userId: string;
        requestBody?: { name?: string };
      }): Promise<RestResponse<unknown>> => {
        return {
          data: LabelSchema.parse({
            id: `Label_${Date.now()}`,
            name: params.requestBody?.name ?? "fixture-label",
            type: "user",
          }),
        };
      },

      update: async (params: {
        userId: string;
        id: string;
        requestBody?: { name?: string };
      }): Promise<RestResponse<unknown>> => {
        return {
          data: LabelSchema.parse({
            id: params.id,
            name: params.requestBody?.name ?? "updated",
            type: "user",
          }),
        };
      },

      delete: async (_params: { userId: string; id: string }): Promise<RestResponse<unknown>> => {
        return { data: {} };
      },
    },

    settings: {
      filters: {
        get: async (params: { userId: string; id: string }): Promise<RestResponse<unknown>> => {
          const filters = this.readFilters();
          const filter = filters.find((f) => f.id === params.id);
          if (!filter) {
            const err = new Error(`filter ${params.id} not found`) as Error & { code: number };
            err.code = 404;
            throw err;
          }
          return { data: FilterSchema.parse(filter) };
        },

        list: async (_params: { userId: string }): Promise<RestResponse<unknown>> => {
          const filters = this.readFilters();
          return { data: ListFiltersResponseSchema.parse({ filter: filters }) };
        },

        create: async (_params: {
          userId: string;
          requestBody?: unknown;
        }): Promise<RestResponse<unknown>> => {
          return {
            data: FilterSchema.parse({
              id: `Filter_${Date.now()}`,
              criteria: {},
              action: {},
            }),
          };
        },

        delete: async (_params: { userId: string; id: string }): Promise<RestResponse<unknown>> => {
          return { data: {} };
        },
      },
    },
  };

  // ── Internals ───────────────────────────────────────────────────────────

  private readJson(rel: string): unknown {
    const full = path.join(this.accountDir, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`Fixture file not found: ${full}`);
    }
    return JSON.parse(fs.readFileSync(full, "utf8"));
  }

  private listAllMessages(): Array<ReturnType<typeof MessageSchema.parse>> {
    const dir = path.join(this.accountDir, "messages");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => MessageSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
  }

  private listAllThreads(): Array<ReturnType<typeof ThreadSchema.parse>> {
    const dir = path.join(this.accountDir, "threads");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ThreadSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
  }

  private readLabels(): Array<ReturnType<typeof LabelSchema.parse>> {
    const file = path.join(this.accountDir, "labels.json");
    if (!fs.existsSync(file)) return [];
    const arr = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
    return arr.map((x) => LabelSchema.parse(x));
  }

  private readFilters(): Array<ReturnType<typeof FilterSchema.parse>> {
    const file = path.join(this.accountDir, "filters.json");
    if (!fs.existsSync(file)) return [];
    const arr = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
    return arr.map((x) => FilterSchema.parse(x));
  }

  private filterByQuery(
    messages: Array<ReturnType<typeof MessageSchema.parse>>,
    query: string | undefined,
    labelIds: string[] | undefined,
  ): Array<ReturnType<typeof MessageSchema.parse>> {
    if (!query && !labelIds) return messages;
    return messages.filter((m) => {
      if (labelIds && labelIds.length > 0) {
        const messageLabels = m.labelIds ?? [];
        if (!labelIds.every((id) => messageLabels.includes(id))) return false;
      }
      if (query) {
        // Minimal Gmail-query support: `in:<label>` and `from:<addr>` and
        // `subject:<text>`. Anything else passes through as a substring snippet
        // match so tests can write naturalistic queries without us reimplementing
        // Gmail's query parser.
        const inMatch = /\bin:(\S+)/i.exec(query);
        if (inMatch) {
          const label = inMatch[1]!.toUpperCase();
          if (!(m.labelIds ?? []).includes(label)) return false;
        }
        const fromMatch = /\bfrom:(\S+)/i.exec(query);
        if (fromMatch) {
          const from = (this.headerValue(m, "From") ?? "").toLowerCase();
          if (!from.includes(fromMatch[1]!.toLowerCase())) return false;
        }
        const subjectMatch = /\bsubject:(\S+)/i.exec(query);
        if (subjectMatch) {
          const subj = (this.headerValue(m, "Subject") ?? "").toLowerCase();
          if (!subj.includes(subjectMatch[1]!.toLowerCase())) return false;
        }
      }
      return true;
    });
  }

  private filterThreadsByQuery(
    threads: Array<ReturnType<typeof ThreadSchema.parse>>,
    query: string | undefined,
  ): Array<ReturnType<typeof ThreadSchema.parse>> {
    if (!query) return threads;
    const inMatch = /\bin:(\S+)/i.exec(query);
    if (!inMatch) return threads;
    const label = inMatch[1]!.toUpperCase();
    return threads.filter((t) =>
      (t.messages ?? []).some((m) => (m.labelIds ?? []).includes(label)),
    );
  }

  private headerValue(
    message: ReturnType<typeof MessageSchema.parse>,
    name: string,
  ): string | undefined {
    const headers = message.payload?.headers ?? [];
    const lower = name.toLowerCase();
    return headers.find((h) => h.name?.toLowerCase() === lower)?.value;
  }
}

/**
 * Read the per-account scopes file. Falls back to `["gmail.modify"]` if the
 * fixture didn't ship one. The bootstrap reads this to populate
 * authorizedScopes — the dispatcher's scope gate then enforces it normally.
 */
export function readFixtureScopes(accountDir: string): string[] {
  const file = path.join(accountDir, "scopes.json");
  if (!fs.existsSync(file)) return ["gmail.modify"];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${file}: expected an array of scope shortnames`);
  }
  return parsed as string[];
}
