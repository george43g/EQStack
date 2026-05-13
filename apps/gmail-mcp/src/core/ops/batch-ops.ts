// Batch label modify + batch delete. Uses core/batch.ts::processBatches
// for chunking, AbortSignal handling, and per-item-fallback on batch failure.

import { BatchDeleteEmailsSchema, BatchModifyEmailsSchema } from "../../tools.js";
import { processBatches } from "../batch.js";
import { type Operation, registry } from "../registry.js";

const batchModifyEmails: Operation<unknown> = {
  name: "batch_modify_emails",
  schema: BatchModifyEmailsSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as {
      messageIds: string[];
      addLabelIds?: string[];
      removeLabelIds?: string[];
      batchSize?: number;
    };
    const batchSize = args.batchSize || 50;
    const requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
    if (args.addLabelIds) requestBody.addLabelIds = args.addLabelIds;
    if (args.removeLabelIds) requestBody.removeLabelIds = args.removeLabelIds;

    const { successes, failures } = await processBatches(
      args.messageIds,
      batchSize,
      async (batch) => {
        const results = await Promise.all(
          batch.map(async (messageId) => {
            await ctx.gmail.users.messages.modify({
              userId: "me",
              id: messageId,
              requestBody,
            });
            return { messageId, success: true };
          }),
        );
        return results;
      },
      { toolName: ctx.toolName, signal: ctx.signal },
    );

    const successCount = successes.length;
    const failureCount = failures.length;
    let resultText = "Batch label modification complete.\n";
    resultText += `Successfully processed: ${successCount} messages\n`;
    if (failureCount > 0) {
      resultText += `Failed to process: ${failureCount} messages\n\n`;
      resultText += "Failed message IDs:\n";
      resultText += failures
        .map((f) => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`)
        .join("\n");
    }

    return { content: [{ type: "text", text: resultText }] };
  },
};

const batchDeleteEmails: Operation<unknown> = {
  name: "batch_delete_emails",
  schema: BatchDeleteEmailsSchema,
  scopes: ["gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { messageIds: string[]; batchSize?: number };
    const batchSize = args.batchSize || 50;

    const { successes, failures } = await processBatches(
      args.messageIds,
      batchSize,
      async (batch) => {
        const results = await Promise.all(
          batch.map(async (messageId) => {
            await ctx.gmail.users.messages.delete({
              userId: "me",
              id: messageId,
            });
            return { messageId, success: true };
          }),
        );
        return results;
      },
      { toolName: ctx.toolName, signal: ctx.signal },
    );

    const successCount = successes.length;
    const failureCount = failures.length;
    let resultText = "Batch delete operation complete.\n";
    resultText += `Successfully deleted: ${successCount} messages\n`;
    if (failureCount > 0) {
      resultText += `Failed to delete: ${failureCount} messages\n\n`;
      resultText += "Failed message IDs:\n";
      resultText += failures
        .map((f) => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`)
        .join("\n");
    }

    return { content: [{ type: "text", text: resultText }] };
  },
};

registry.register(batchModifyEmails);
registry.register(batchDeleteEmails);
