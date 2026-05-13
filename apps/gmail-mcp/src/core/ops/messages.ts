// Message-level ops: read, search, modify (labels), delete.
//
// Lifted verbatim from the dispatcher switch in src/index.ts during the
// modular refactor (Step 4). Zero behavior change — same Gmail calls, same
// output text, same retry/rate-limit wrapping for the read paths.

import { rateLimitAcquire, withRetry } from "../../robustness/index.js";
import {
  DeleteEmailSchema,
  ModifyEmailSchema,
  ReadEmailSchema,
  SearchEmailsSchema,
} from "../../tools.js";
import {
  extractAttachments,
  extractEmailContent,
  extractHeaders,
  type GmailMessagePart,
} from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";

const readEmail: Operation<unknown> = {
  name: "read_email",
  schema: ReadEmailSchema,
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
    const { text, html } = extractEmailContent((response.data.payload as GmailMessagePart) || {});
    const attachments = extractAttachments(response.data.payload as GmailMessagePart);

    const body = text || html || "";
    const contentTypeNote =
      !text && html
        ? "[Note: This email is HTML-formatted. Plain text version not available.]\n\n"
        : "";
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
          text: `Thread ID: ${threadId}\nMessage-ID: ${rfcMessageId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}\n\n${contentTypeNote}${body}${attachmentInfo}`,
        },
      ],
    };
  },
};

const searchEmails: Operation<unknown> = {
  name: "search_emails",
  schema: SearchEmailsSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { query: string; maxResults?: number };
    await rateLimitAcquire();
    const response = await withRetry(
      () =>
        ctx.gmail.users.messages.list({
          userId: "me",
          q: args.query,
          maxResults: args.maxResults || 10,
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
          id: msg.id,
          subject: headers.find((h) => h.name === "Subject")?.value || "",
          from: headers.find((h) => h.name === "From")?.value || "",
          date: headers.find((h) => h.name === "Date")?.value || "",
        };
      }),
    );

    return {
      content: [
        {
          type: "text",
          text: results
            .map((r) => `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`)
            .join("\n"),
        },
      ],
    };
  },
};

const modifyEmail: Operation<unknown> = {
  name: "modify_email",
  schema: ModifyEmailSchema,
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
      content: [
        {
          type: "text",
          text: `Email ${args.messageId} labels updated successfully`,
        },
      ],
    };
  },
};

const deleteEmail: Operation<unknown> = {
  name: "delete_email",
  schema: DeleteEmailSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { messageId: string };
    await ctx.gmail.users.messages.delete({
      userId: "me",
      id: args.messageId,
    });
    return {
      content: [
        {
          type: "text",
          text: `Email ${args.messageId} deleted successfully`,
        },
      ],
    };
  },
};

registry.register(readEmail);
registry.register(searchEmails);
registry.register(modifyEmail);
registry.register(deleteEmail);
