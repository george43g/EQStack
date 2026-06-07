// Message-level ops: read, search, modify (labels), delete.
//
// Lifted verbatim from the dispatcher switch in src/index.ts during the
// modular refactor (Step 4). Zero behavior change — same Gmail calls, same
// output text, same retry/rate-limit wrapping for the read paths.

import type { z } from "zod";
import { rateLimitAcquire, withRetry } from "../../robustness/index.js";
import {
  DeleteEmailSchema,
  ModifyEmailSchema,
  ModifyOrDeleteEmailOutputSchema,
  ReadEmailOutputSchema,
  ReadEmailSchema,
  SearchEmailsOutputSchema,
  SearchEmailsSchema,
} from "../../tools.js";
import {
  extractAttachments,
  extractEmailContent,
  extractHeaders,
  type GmailMessagePart,
  readableEmailBody,
} from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";

type ReadEmailOutput = z.infer<typeof ReadEmailOutputSchema>;
type SearchEmailsOutput = z.infer<typeof SearchEmailsOutputSchema>;
type ModifyOrDeleteEmailOutput = z.infer<typeof ModifyOrDeleteEmailOutputSchema>;

const readEmail: Operation<unknown, ReadEmailOutput> = {
  name: "read_email",
  schema: ReadEmailSchema,
  outputSchema: ReadEmailOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { messageId: string };
    await rateLimitAcquire();
    const response = await withRetry(
      () =>
        ctx.gmail.users.messages.get({
          userId: "me",
          id: args.messageId,
          format: "full",
        }),
      { label: "gmail_messages_get" },
    );

    const { subject, from, to, date, rfcMessageId } = extractHeaders(response.data.payload);
    const threadId = response.data.threadId || "";
    const extracted = extractEmailContent((response.data.payload as GmailMessagePart) || {});
    const { text, html } = extracted;
    const attachments = extractAttachments(response.data.payload as GmailMessagePart);

    const body = readableEmailBody(extracted);
    const attachmentInfo =
      attachments.length > 0
        ? `\n\nAttachments (${attachments.length}):\n` +
          attachments
            .map(
              (a) =>
                `- ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)} KB, ID: ${a.id})`,
            )
            .join("\n")
        : "";

    return {
      content: [
        {
          type: "text",
          text: `Thread ID: ${threadId}\nMessage-ID: ${rfcMessageId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}\n\n${body}${attachmentInfo}`,
        },
      ],
      structuredContent: {
        messageId: args.messageId,
        threadId,
        subject,
        from,
        to,
        date,
        rfcMessageId,
        body,
        bodyText: text,
        bodyHtml: html,
        attachments,
      },
    };
  },
};

const searchEmails: Operation<unknown, SearchEmailsOutput> = {
  name: "search_emails",
  schema: SearchEmailsSchema,
  outputSchema: SearchEmailsOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { query: string; maxResults?: number; pageToken?: string };
    await rateLimitAcquire();
    const response = await withRetry(
      () =>
        ctx.gmail.users.messages.list({
          userId: "me",
          q: args.query,
          maxResults: args.maxResults || 10,
          ...(args.pageToken ? { pageToken: args.pageToken } : {}),
        }),
      { label: "gmail_messages_list" },
    );

    const messages = response.data.messages || [];
    const results = await Promise.all(
      messages.map(async (msg) => {
        const detail = await ctx.gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        });
        const headers = detail.data.payload?.headers || [];
        return {
          id: msg.id ?? null,
          subject: headers.find((h) => h.name === "Subject")?.value || "",
          from: headers.find((h) => h.name === "From")?.value || "",
          date: headers.find((h) => h.name === "Date")?.value || "",
        };
      }),
    );

    const structured: SearchEmailsOutput = {
      resultCount: results.length,
      results,
    };
    if (response.data.nextPageToken) {
      structured.nextPageToken = response.data.nextPageToken;
    }
    if (typeof response.data.resultSizeEstimate === "number") {
      structured.resultSizeEstimate = response.data.resultSizeEstimate;
    }

    return {
      content: [
        {
          type: "text",
          text: results
            .map((r) => `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`)
            .join("\n"),
        },
      ],
      structuredContent: structured,
    };
  },
};

const modifyEmail: Operation<unknown, ModifyOrDeleteEmailOutput> = {
  name: "modify_email",
  schema: ModifyEmailSchema,
  outputSchema: ModifyOrDeleteEmailOutputSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as {
      messageId: string;
      labelIds?: string[];
      addLabelIds?: string[];
      removeLabelIds?: string[];
    };

    // Match the legacy precedence: explicit addLabelIds wins over the
    // deprecated `labelIds` field; removeLabelIds is always honored.
    const requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
    if (args.labelIds) requestBody.addLabelIds = args.labelIds;
    if (args.addLabelIds) requestBody.addLabelIds = args.addLabelIds;
    if (args.removeLabelIds) requestBody.removeLabelIds = args.removeLabelIds;

    await ctx.gmail.users.messages.modify({
      userId: "me",
      id: args.messageId,
      requestBody,
    });

    return {
      content: [{ type: "text", text: `Email ${args.messageId} labels updated successfully` }],
      structuredContent: { messageId: args.messageId, status: "modified" },
    };
  },
};

const deleteEmail: Operation<unknown, ModifyOrDeleteEmailOutput> = {
  name: "delete_email",
  schema: DeleteEmailSchema,
  outputSchema: ModifyOrDeleteEmailOutputSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { messageId: string };
    await ctx.gmail.users.messages.delete({
      userId: "me",
      id: args.messageId,
    });
    return {
      content: [{ type: "text", text: `Email ${args.messageId} deleted successfully` }],
      structuredContent: { messageId: args.messageId, status: "deleted" },
    };
  },
};

registry.register(readEmail);
registry.register(searchEmails);
registry.register(modifyEmail);
registry.register(deleteEmail);
