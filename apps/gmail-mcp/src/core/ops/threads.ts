// Thread-level ops: get_thread, list_inbox_threads, get_inbox_with_threads,
// modify_thread. Lifted verbatim from src/index.ts switch.

import type { EmailAttachment } from "../../email-export.js";
import {
  GetInboxWithThreadsSchema,
  GetThreadSchema,
  ListInboxThreadsSchema,
  ModifyThreadSchema,
} from "../../tools.js";
import { extractEmailContent, type GmailMessagePart } from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";

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

const getThread: Operation<unknown> = {
  name: "get_thread",
  schema: GetThreadSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { threadId: string; format?: "full" | "metadata" | "minimal" };
    const threadResponse = await ctx.gmail.users.threads.get({
      userId: "me",
      id: args.threadId,
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
        const { text, html } = extractEmailContent((msg.payload as GmailMessagePart) || {});
        body = text || html || "";
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
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        })),
      };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              threadId: args.threadId,
              messageCount: messagesOutput.length,
              messages: messagesOutput,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

const listInboxThreads: Operation<unknown> = {
  name: "list_inbox_threads",
  schema: ListInboxThreadsSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { query?: string; maxResults?: number };
    const threadsResponse = await ctx.gmail.users.threads.list({
      userId: "me",
      q: args.query || "in:inbox",
      maxResults: args.maxResults || 50,
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              resultCount: threadDetails.length,
              threads: threadDetails,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

const getInboxWithThreads: Operation<unknown> = {
  name: "get_inbox_with_threads",
  schema: GetInboxWithThreadsSchema,
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                resultCount: threadSummaries.length,
                threads: threadSummaries,
              },
              null,
              2,
            ),
          },
        ],
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

          const { text, html } = extractEmailContent((msg.payload as GmailMessagePart) || {});
          const body = text || html || "";

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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              resultCount: expandedThreads.length,
              threads: expandedThreads,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

const modifyThread: Operation<unknown> = {
  name: "modify_thread",
  schema: ModifyThreadSchema,
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
    };
  },
};

registry.register(getThread);
registry.register(listInboxThreads);
registry.register(getInboxWithThreads);
registry.register(modifyThread);
