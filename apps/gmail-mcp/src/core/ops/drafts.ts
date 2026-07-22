// draft_email op — uses the shared handleEmailAction from send.ts.

import type { z } from "zod";
import {
  DeleteDraftOutputSchema,
  DeleteDraftSchema,
  SendDraftOutputSchema,
  SendDraftSchema,
  SendEmailSchema,
  SendOrDraftOutputSchema,
  UpdateDraftOutputSchema,
  UpdateDraftSchema,
} from "../../tools.js";
import { createEmailMessage, createEmailWithNodemailer, needsRawBuilder } from "../../utl.js";
import { type Operation, registry } from "../registry.js";
import { handleEmailAction, type SendOrDraftOutput } from "./send.js";

type SendDraftOutput = z.infer<typeof SendDraftOutputSchema>;
type UpdateDraftOutput = z.infer<typeof UpdateDraftOutputSchema>;
type DeleteDraftOutput = z.infer<typeof DeleteDraftOutputSchema>;

const draftEmail: Operation<unknown, SendOrDraftOutput> = {
  name: "draft_email",
  schema: SendEmailSchema,
  outputSchema: SendOrDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose"],
  handler: async (input, ctx) => handleEmailAction("draft", input as any, ctx.gmail),
};

const sendDraft: Operation<unknown, SendDraftOutput> = {
  name: "send_draft",
  schema: SendDraftSchema,
  outputSchema: SendDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
  handler: async (input, ctx) => {
    const { draftId } = input as z.infer<typeof SendDraftSchema>;
    const response = await ctx.gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
    });
    const structured: SendDraftOutput = {
      draftId,
      messageId: response.data.id ?? "",
      status: "sent",
    };
    if (response.data.threadId) structured.threadId = response.data.threadId;
    return {
      content: [
        {
          type: "text",
          text: `Draft ${draftId} sent successfully as message ${structured.messageId}. The draft was removed from Drafts.`,
        },
      ],
      structuredContent: structured,
    };
  },
};

const updateDraft: Operation<unknown, UpdateDraftOutput> = {
  name: "update_draft",
  schema: UpdateDraftSchema,
  outputSchema: UpdateDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose"],
  handler: async (input, ctx) => {
    const { draftId, ...messageArgs } = input as z.infer<typeof UpdateDraftSchema>;
    const message = needsRawBuilder(messageArgs)
      ? await createEmailWithNodemailer(messageArgs)
      : createEmailMessage(messageArgs);
    const raw = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const response = await ctx.gmail.users.drafts.update({
      userId: "me",
      id: draftId,
      requestBody: {
        message: {
          raw,
          ...(messageArgs.threadId ? { threadId: messageArgs.threadId } : {}),
        },
      },
    });

    const structured: UpdateDraftOutput = {
      draftId: response.data.id ?? draftId,
      status: "updated",
    };
    if (response.data.message?.id) structured.messageId = response.data.message.id;
    if (response.data.message?.threadId) structured.threadId = response.data.message.threadId;
    return {
      content: [{ type: "text", text: `Draft ${structured.draftId} updated successfully.` }],
      structuredContent: structured,
    };
  },
};

const deleteDraft: Operation<unknown, DeleteDraftOutput> = {
  name: "delete_draft",
  schema: DeleteDraftSchema,
  outputSchema: DeleteDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose"],
  handler: async (input, ctx) => {
    const { draftId } = input as z.infer<typeof DeleteDraftSchema>;
    await ctx.gmail.users.drafts.delete({ userId: "me", id: draftId });
    return {
      content: [{ type: "text", text: `Draft ${draftId} deleted successfully.` }],
      structuredContent: { draftId, status: "deleted" },
    };
  },
};

registry.register(draftEmail);
registry.register(sendDraft);
registry.register(updateDraft);
registry.register(deleteDraft);
