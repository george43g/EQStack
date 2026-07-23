// Thread-level ops: get_thread, list_inbox_threads, get_inbox_with_threads,
// modify_thread. Lifted verbatim from src/index.ts switch.

import type { z } from "zod";
import type { EmailAttachment } from "../../email-export.js";
import {
  GetInboxWithThreadsOutputSchema,
  GetInboxWithThreadsSchema,
  GetThreadOutputSchema,
  GetThreadSchema,
  ListInboxThreadsOutputSchema,
  ListInboxThreadsSchema,
  ModifyThreadOutputSchema,
  ModifyThreadSchema,
} from "../../tools.js";
import { extractEmailContent, type GmailMessagePart, readableEmailBody } from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";

type GetThreadOutput = z.infer<typeof GetThreadOutputSchema>;
type ListInboxThreadsOutput = z.infer<typeof ListInboxThreadsOutputSchema>;
type GetInboxWithThreadsOutput = z.infer<typeof GetInboxWithThreadsOutputSchema>;
type ModifyThreadOutput = z.infer<typeof ModifyThreadOutputSchema>;

/**
 * Walk a Gmail message payload and collect attachment metadata.
 * Local to threads.ts because the legacy code inlines this walk; it's
 * functionally equivalent to extractAttachments from core/email-helpers.ts.
 * Keeping the inline shape here preserves the exact JSON output (filename
 * fallback string format, mime/size defaults) that callers may depend on.
 */
function collectAttachmentMeta(payload: GmailMessagePart | undefined): EmailAttachment[] {
  const attachments: EmailAttachment[] = [];
  const walk = (part: GmailMessagePart) => {
    if (part.body?.attachmentId) {
      const filename = part.filename || `attachment-${part.body.attachmentId}`;
      attachments.push({
        id: part.body.attachmentId,
        filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size || 0,
      });
    }
    if (part.parts) {
      part.parts.forEach((subpart: GmailMessagePart) => walk(subpart));
    }
  };
  if (payload) walk(payload);
  return attachments;
}

const getThread: Operation<unknown, GetThreadOutput> = {
  name: "get_thread",
  schema: GetThreadSchema,
  outputSchema: GetThreadOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as {
      threadId?: string;
      messageId?: string;
      format?: "full" | "metadata" | "minimal";
    };

    // Accept a messageId as an alternative to threadId: resolve it to its
    // thread with a cheap `minimal` fetch (only .threadId is needed). This
    // removes the read_email round-trip callers otherwise need after a search.
    let threadId = args.threadId;
    if (!threadId && args.messageId) {
      const msg = await ctx.gmail.users.messages.get({
        userId: "me",
        id: args.messageId,
        format: "minimal",
      });
      threadId = msg.data.threadId || undefined;
      if (!threadId) {
        throw new Error(`Could not resolve a threadId from message ${args.messageId}`);
      }
    }

    const threadResponse = await ctx.gmail.users.threads.get({
      userId: "me",
      id: threadId!,
      format: args.format || "full",
    });

    const threadMessages = threadResponse.data.messages || [];
    const messagesOutput = threadMessages.map((msg) => {
      const headers = msg.payload?.headers || [];
      const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
      const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
      const to = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
      const cc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
      const bcc = headers.find((h) => h.name?.toLowerCase() === "bcc")?.value || "";
      const date = headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

      let body = "";
      if (args.format !== "minimal") {
        body = readableEmailBody(extractEmailContent((msg.payload as GmailMessagePart) || {}));
      }

      const attachments = collectAttachmentMeta(msg.payload as GmailMessagePart | undefined);

      return {
        messageId: msg.id || "",
        threadId: msg.threadId || "",
        from,
        to,
        cc,
        bcc,
        subject,
        date,
        body,
        labelIds: msg.labelIds || [],
        attachments: attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        })),
      };
    });

    const structured = {
      threadId: threadId!,
      messageCount: messagesOutput.length,
      messages: messagesOutput,
    };
    return {
      content: [{ type: "text", text: renderThreadTranscript(structured) }],
      structuredContent: structured,
    };
  },
};

const listInboxThreads: Operation<unknown, ListInboxThreadsOutput> = {
  name: "list_inbox_threads",
  schema: ListInboxThreadsSchema,
  outputSchema: ListInboxThreadsOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { query?: string; maxResults?: number; pageToken?: string };
    const threadsResponse = await ctx.gmail.users.threads.list({
      userId: "me",
      q: args.query || "in:inbox",
      maxResults: args.maxResults || 50,
      ...(args.pageToken ? { pageToken: args.pageToken } : {}),
    });

    const threads = threadsResponse.data.threads || [];

    const threadDetails = await Promise.all(
      threads.map(async (thread) => {
        const detail = await ctx.gmail.users.threads.get({
          userId: "me",
          id: thread.id!,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        });

        const messages = detail.data.messages || [];
        const latestMessage = messages[messages.length - 1];
        const latestHeaders = latestMessage?.payload?.headers || [];

        return {
          threadId: thread.id || "",
          snippet: thread.snippet || "",
          historyId: thread.historyId || "",
          messageCount: messages.length,
          latestMessage: {
            from: latestHeaders.find((h) => h.name === "From")?.value || "",
            subject: latestHeaders.find((h) => h.name === "Subject")?.value || "",
            date: latestHeaders.find((h) => h.name === "Date")?.value || "",
          },
        };
      }),
    );

    const structured: ListInboxThreadsOutput = {
      resultCount: threadDetails.length,
      threads: threadDetails,
    };
    if (threadsResponse.data.nextPageToken) {
      structured.nextPageToken = threadsResponse.data.nextPageToken;
    }
    if (typeof threadsResponse.data.resultSizeEstimate === "number") {
      structured.resultSizeEstimate = threadsResponse.data.resultSizeEstimate;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
      structuredContent: structured,
    };
  },
};

const getInboxWithThreads: Operation<unknown, GetInboxWithThreadsOutput> = {
  name: "get_inbox_with_threads",
  schema: GetInboxWithThreadsSchema,
  outputSchema: GetInboxWithThreadsOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { query?: string; maxResults?: number; expandThreads?: boolean };
    const threadsResponse = await ctx.gmail.users.threads.list({
      userId: "me",
      q: args.query || "in:inbox",
      maxResults: args.maxResults || 50,
    });

    const threads = threadsResponse.data.threads || [];

    if (!args.expandThreads) {
      // Same as list_inbox_threads when expand=false
      const threadSummaries = await Promise.all(
        threads.map(async (thread) => {
          const detail = await ctx.gmail.users.threads.get({
            userId: "me",
            id: thread.id!,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });

          const messages = detail.data.messages || [];
          const latestMessage = messages[messages.length - 1];
          const latestHeaders = latestMessage?.payload?.headers || [];

          return {
            threadId: thread.id || "",
            snippet: thread.snippet || "",
            historyId: thread.historyId || "",
            messageCount: messages.length,
            latestMessage: {
              from: latestHeaders.find((h) => h.name === "From")?.value || "",
              subject: latestHeaders.find((h) => h.name === "Subject")?.value || "",
              date: latestHeaders.find((h) => h.name === "Date")?.value || "",
            },
          };
        }),
      );

      const summaryStructured = {
        resultCount: threadSummaries.length,
        threads: threadSummaries,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(summaryStructured, null, 2) }],
        structuredContent: summaryStructured,
      };
    }

    // expandThreads: fetch full content per thread in parallel
    const expandedThreads = await Promise.all(
      threads.map(async (thread) => {
        const threadDetail = await ctx.gmail.users.threads.get({
          userId: "me",
          id: thread.id!,
          format: "full",
        });

        const threadMessages = threadDetail.data.messages || [];

        const messages = threadMessages.map((msg) => {
          const headers = msg.payload?.headers || [];
          const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
          const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
          const to = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
          const cc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
          const bcc = headers.find((h) => h.name?.toLowerCase() === "bcc")?.value || "";
          const date = headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

          const body = readableEmailBody(
            extractEmailContent((msg.payload as GmailMessagePart) || {}),
          );

          const attachments = collectAttachmentMeta(msg.payload as GmailMessagePart | undefined);

          return {
            messageId: msg.id || "",
            threadId: msg.threadId || "",
            from,
            to,
            cc,
            bcc,
            subject,
            date,
            body,
            labelIds: msg.labelIds || [],
            attachments: attachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              mimeType: a.mimeType,
              size: a.size,
            })),
          };
        });

        return {
          threadId: thread.id || "",
          messageCount: messages.length,
          messages,
        };
      }),
    );

    const expandedStructured = {
      resultCount: expandedThreads.length,
      threads: expandedThreads,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(expandedStructured, null, 2) }],
      structuredContent: expandedStructured,
    };
  },
};

const modifyThread: Operation<unknown, ModifyThreadOutput> = {
  name: "modify_thread",
  schema: ModifyThreadSchema,
  outputSchema: ModifyThreadOutputSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { threadId: string; addLabelIds?: string[]; removeLabelIds?: string[] };

    const modifyRequestBody: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
    if (args.addLabelIds) modifyRequestBody.addLabelIds = args.addLabelIds;
    if (args.removeLabelIds) modifyRequestBody.removeLabelIds = args.removeLabelIds;

    await ctx.gmail.users.threads.modify({
      userId: "me",
      id: args.threadId,
      requestBody: modifyRequestBody,
    });

    return {
      content: [
        {
          type: "text",
          text: `Thread ${args.threadId} labels updated successfully (all messages in thread modified)`,
        },
      ],
      structuredContent: { threadId: args.threadId, status: "modified" },
    };
  },
};

registry.register(getThread);
registry.register(listInboxThreads);
registry.register(getInboxWithThreads);
registry.register(modifyThread);

function renderThreadTranscript(thread: GetThreadOutput): string {
  const messageNoun = thread.messageCount === 1 ? "message" : "messages";
  const lines = [`Thread ${thread.threadId} (${thread.messageCount} ${messageNoun})`];

  thread.messages.forEach((msg, index) => {
    if (index > 0) lines.push("");
    const subject = msg.subject || "(no subject)";
    lines.push(`--- Message ${index + 1}/${thread.messageCount}: ${subject}`);
    const accountId = (msg as { accountId?: string }).accountId;
    const emailAddress = (msg as { emailAddress?: string | null }).emailAddress;
    if (accountId) {
      lines.push(`Account: ${accountId}${emailAddress ? ` <${emailAddress}>` : ""}`);
    }
    lines.push(`From: ${msg.from}`);
    if (msg.to) lines.push(`To: ${msg.to}`);
    if (msg.cc) lines.push(`Cc: ${msg.cc}`);
    if (msg.bcc) lines.push(`Bcc: ${msg.bcc}`);
    if (msg.date) lines.push(`Date: ${msg.date}`);
    if (msg.labelIds.length > 0) lines.push(`Labels: ${msg.labelIds.join(", ")}`);
    if (msg.attachments.length > 0) {
      lines.push(
        `Attachments: ${msg.attachments
          .map((a) => `${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)} KB)`)
          .join(", ")}`,
      );
    }
    lines.push("");
    lines.push(msg.body || "(no body)");
  });

  return lines.join("\n");
}
