// send_email + reply_all ops, plus the shared `handleEmailAction` helper
// used by both send and draft paths. Lifted from src/index.ts verbatim.

import type { gmail_v1 } from "googleapis";
import type { z } from "zod";
import {
  addRePrefix,
  buildReferencesHeader,
  buildReplyAllRecipients,
  parseEmailAddresses,
  pickReplyFromIdentity,
} from "../../reply-all-helpers.js";
import { listSendAs } from "../../sendas-manager.js";
import {
  ReplyAllOutputSchema,
  ReplyAllSchema,
  SendEmailSchema,
  SendOrDraftOutputSchema,
} from "../../tools.js";
import { createEmailMessage, createEmailWithNodemailer, needsRawBuilder } from "../../utl.js";
import type { OperationContext } from "../context.js";
import { type Operation, type OperationResult, registry } from "../registry.js";

export type SendOrDraftOutput = z.infer<typeof SendOrDraftOutputSchema>;
type ReplyAllOutput = z.infer<typeof ReplyAllOutputSchema>;

/**
 * Shared send/draft worker. Auto-resolves threading headers when a threadId
 * is provided but inReplyTo is missing. Handles both the nodemailer-RFC822
 * path (when attachments are present) and the simple base64-encoded path.
 *
 * Exported because draft_email (in core/ops/drafts.ts) and reply_all (below)
 * both delegate here. Private to the ops layer otherwise.
 */
export async function handleEmailAction(
  action: "send" | "draft",
  validatedArgs: any,
  gmail: gmail_v1.Gmail,
): Promise<OperationResult<SendOrDraftOutput>> {
  let message: string;

  try {
    // Auto-resolve threading headers when threadId is provided but inReplyTo is missing
    if (validatedArgs.threadId && !validatedArgs.inReplyTo) {
      try {
        const threadResponse = await gmail.users.threads.get({
          userId: "me",
          id: validatedArgs.threadId,
          format: "metadata",
          metadataHeaders: ["Message-ID"],
        });

        const threadMessages = threadResponse.data.messages || [];
        if (threadMessages.length > 0) {
          const allMessageIds: string[] = [];
          for (const msg of threadMessages) {
            const msgHeaders = msg.payload?.headers || [];
            const messageIdHeader = msgHeaders.find((h) => h.name?.toLowerCase() === "message-id");
            if (messageIdHeader?.value) {
              allMessageIds.push(messageIdHeader.value);
            }
          }

          const lastMessage = threadMessages[threadMessages.length - 1];
          const lastHeaders = lastMessage.payload?.headers || [];
          const lastMessageId = lastHeaders.find(
            (h) => h.name?.toLowerCase() === "message-id",
          )?.value;

          if (lastMessageId) {
            validatedArgs.inReplyTo = lastMessageId;
          }
          if (allMessageIds.length > 0) {
            validatedArgs.references = allMessageIds.join(" ");
          }
        }
      } catch (threadError: any) {
        console.warn(
          `Warning: Could not fetch thread ${validatedArgs.threadId} for header resolution: ${threadError.message}`,
        );
        // Continue without threading headers - degraded but not broken
      }
    }

    if (needsRawBuilder(validatedArgs)) {
      // Use nodemailer to construct a proper RFC822 multipart message.
      message = await createEmailWithNodemailer(validatedArgs);
      const encodedMessage = Buffer.from(message)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      if (action === "send") {
        const result = await gmail.users.messages.send({
          userId: "me",
          requestBody: {
            raw: encodedMessage,
            ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
          },
        });
        return {
          content: [{ type: "text", text: `Email sent successfully with ID: ${result.data.id}` }],
          structuredContent: {
            messageId: result.data.id ?? "",
            action: "sent",
            threadId: validatedArgs.threadId,
          },
        };
      }
      // draft branch
      const messageRequest = {
        raw: encodedMessage,
        ...(validatedArgs.threadId && { threadId: validatedArgs.threadId }),
      };
      const response = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: messageRequest },
      });
      return {
        content: [
          { type: "text", text: `Email draft created successfully with ID: ${response.data.id}` },
        ],
        structuredContent: {
          messageId: response.data.id ?? "",
          draftId: response.data.id ?? "",
          action: "drafted",
          threadId: validatedArgs.threadId,
        },
      };
    }

    // No-attachment path: simpler raw RFC822 via utl.createEmailMessage.
    message = createEmailMessage(validatedArgs);
    const encodedMessage = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    interface GmailMessageRequest {
      raw: string;
      threadId?: string;
    }
    const messageRequest: GmailMessageRequest = { raw: encodedMessage };
    if (validatedArgs.threadId) messageRequest.threadId = validatedArgs.threadId;

    if (action === "send") {
      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: messageRequest,
      });
      return {
        content: [{ type: "text", text: `Email sent successfully with ID: ${response.data.id}` }],
        structuredContent: {
          messageId: response.data.id ?? "",
          action: "sent",
          threadId: validatedArgs.threadId,
        },
      };
    }
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: messageRequest },
    });
    return {
      content: [
        { type: "text", text: `Email draft created successfully with ID: ${response.data.id}` },
      ],
      structuredContent: {
        messageId: response.data.id ?? "",
        draftId: response.data.id ?? "",
        action: "drafted",
        threadId: validatedArgs.threadId,
      },
    };
  } catch (error: any) {
    if (needsRawBuilder(validatedArgs)) {
      console.error("Failed to build or send MIME email:", error.message);
    }
    throw error;
  }
}

const sendEmail: Operation<unknown, SendOrDraftOutput> = {
  name: "send_email",
  schema: SendEmailSchema,
  outputSchema: SendOrDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
  handler: async (input, ctx: OperationContext) =>
    handleEmailAction("send", input as any, ctx.gmail),
};

const replyAll: Operation<unknown, ReplyAllOutput> = {
  name: "reply_all",
  schema: ReplyAllSchema,
  outputSchema: ReplyAllOutputSchema,
  scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
  handler: async (input, ctx: OperationContext) => {
    const args = input as any;
    // Fetch the original email to get headers
    const originalEmail = await ctx.gmail.users.messages.get({
      userId: "me",
      id: args.messageId,
      format: "full",
    });

    const headers = originalEmail.data.payload?.headers || [];
    const threadId = originalEmail.data.threadId || "";

    const originalFrom = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
    const originalTo = headers.find((h) => h.name?.toLowerCase() === "to")?.value || "";
    const originalCc = headers.find((h) => h.name?.toLowerCase() === "cc")?.value || "";
    const originalDeliveredTo =
      headers.find((h) => h.name?.toLowerCase() === "delivered-to")?.value || "";
    const originalSubject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    const originalMessageId =
      headers.find((h) => h.name?.toLowerCase() === "message-id")?.value || "";
    const originalReferences =
      headers.find((h) => h.name?.toLowerCase() === "references")?.value || "";

    // Get authenticated user's email to exclude from recipients
    const profile = await ctx.gmail.users.getProfile({ userId: "me" });
    const myEmail = profile.data.emailAddress?.toLowerCase() || "";

    const { to: replyTo, cc: replyCc } = buildReplyAllRecipients(
      originalFrom,
      originalTo,
      originalCc,
      myEmail,
    );

    if (replyTo.length === 0) {
      throw new Error("Could not determine recipient for reply");
    }

    // Closest-matching reply-from selection. An explicit `from` in the args
    // always wins; otherwise pick the send-as identity nearest to whatever
    // address the original was delivered to (exact alias > same-domain alias),
    // which handles catch-all domains where no exact alias exists. Reading
    // send-as settings is best-effort — a failure degrades to the account
    // default ("me") rather than breaking the reply.
    let fromIdentity: string | undefined = args.from;
    if (!fromIdentity) {
      try {
        const aliases = await listSendAs(ctx.gmail);
        const deliveredTo = [
          ...parseEmailAddresses(originalTo),
          ...parseEmailAddresses(originalCc),
          ...parseEmailAddresses(originalDeliveredTo),
        ];
        fromIdentity = pickReplyFromIdentity(deliveredTo, aliases);
      } catch {
        // Settings unreadable (scope/permission) — fall back to default send-as.
      }
    }

    const replySubject = addRePrefix(originalSubject);
    // References header is built but unused here — handleEmailAction recomputes
    // from validatedArgs.references; preserves legacy behavior by computing it
    // (kept for parity even though immediately discarded).
    const _references = buildReferencesHeader(originalReferences, originalMessageId);

    const emailArgs = {
      to: replyTo,
      cc: replyCc.length > 0 ? replyCc : undefined,
      subject: replySubject,
      body: args.body,
      htmlBody: args.htmlBody,
      mimeType: args.mimeType,
      threadId,
      inReplyTo: originalMessageId,
      attachments: args.attachments,
      inlineImages: args.inlineImages,
      ...(fromIdentity ? { from: fromIdentity } : {}),
    };

    await handleEmailAction("send", emailArgs, ctx.gmail);

    const fromLine = fromIdentity ? `\nFrom: ${fromIdentity}` : "";
    return {
      content: [
        {
          type: "text",
          text: `Reply-all sent successfully!${fromLine}\nTo: ${replyTo.join(", ")}${replyCc.length > 0 ? `\nCC: ${replyCc.join(", ")}` : ""}\nSubject: ${replySubject}\nThread ID: ${threadId}`,
        },
      ],
      structuredContent: {
        to: replyTo,
        cc: replyCc,
        subject: replySubject,
        threadId,
        inReplyTo: originalMessageId,
        fromIdentity: fromIdentity ?? null,
      },
    };
  },
};

registry.register(sendEmail);
registry.register(replyAll);
