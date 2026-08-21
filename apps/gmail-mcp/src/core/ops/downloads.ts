// download_email + download_attachment ops. Path-traversal protected via
// safeJoinWithinBase. download_email format branches: json/eml/txt/html.

import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { emailToHtml, emailToTxt, gmailMessageToJson } from "../../email-export.js";
import { safeJoinWithinBase } from "../../safe-path.js";
import {
  DownloadAttachmentOutputSchema,
  DownloadAttachmentSchema,
  DownloadEmailOutputSchema,
  DownloadEmailSchema,
} from "../../tools.js";
import {
  extractAttachments,
  extractEmailContent,
  extractHeaders,
  type GmailMessagePart,
} from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";

type DownloadEmailOutput = z.infer<typeof DownloadEmailOutputSchema>;
type DownloadAttachmentOutput = z.infer<typeof DownloadAttachmentOutputSchema>;

const downloadEmail: Operation<unknown, DownloadEmailOutput> = {
  name: "download_email",
  schema: DownloadEmailSchema,
  outputSchema: DownloadEmailOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as { messageId: string; savePath: string; format: string };
    const { messageId, savePath, format } = args;

    try {
      if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
      }

      const fullResponse = await ctx.gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const { subject, from, date } = extractHeaders(fullResponse.data.payload);
      const attachments = extractAttachments(fullResponse.data.payload as GmailMessagePart);

      let content: string;

      if (format === "eml") {
        const rawResponse = await ctx.gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "raw",
        });
        content = Buffer.from(rawResponse.data.raw || "", "base64url").toString("utf-8");
      } else {
        const emailContent = extractEmailContent(
          (fullResponse.data.payload as GmailMessagePart) || {},
        );

        if (format === "json") {
          const jsonData = gmailMessageToJson(fullResponse.data, emailContent, attachments);
          content = JSON.stringify(jsonData, null, 2);
        } else if (format === "txt") {
          content = emailToTxt(fullResponse.data, emailContent, attachments);
        } else {
          // html
          content = emailToHtml(emailContent);
        }
      }

      const fullPath = safeJoinWithinBase(savePath, `${messageId}.${format}`);
      fs.writeFileSync(fullPath, content, "utf-8");
      const stats = fs.statSync(fullPath);

      const result = {
        status: "saved" as const,
        path: fullPath,
        size: stats.size,
        messageId,
        subject,
        from,
        date,
        format: format as "json" | "eml" | "txt" | "html",
        attachments,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Failed to download email: ${error.message}` }],
      };
    }
  },
};

const downloadAttachment: Operation<unknown, DownloadAttachmentOutput> = {
  name: "download_attachment",
  schema: DownloadAttachmentSchema,
  outputSchema: DownloadAttachmentOutputSchema,
  scopes: ["gmail.readonly", "gmail.modify"],
  handler: async (input, ctx) => {
    const args = input as {
      messageId: string;
      attachmentId: string;
      savePath?: string;
      filename?: string;
    };

    try {
      const attachmentResponse = await ctx.gmail.users.messages.attachments.get({
        userId: "me",
        messageId: args.messageId,
        id: args.attachmentId,
      });

      if (!attachmentResponse.data.data) {
        throw new Error("No attachment data received");
      }

      const data = attachmentResponse.data.data;
      const buffer = Buffer.from(data, "base64url");

      const savePath = args.savePath || process.cwd();
      let filename = args.filename;

      if (!filename) {
        const messageResponse = await ctx.gmail.users.messages.get({
          userId: "me",
          id: args.messageId,
          format: "full",
        });

        const findAttachment = (part: any): string | null => {
          if (part.body && part.body.attachmentId === args.attachmentId) {
            return part.filename || `attachment-${args.attachmentId}`;
          }
          if (part.parts) {
            for (const subpart of part.parts) {
              const found = findAttachment(subpart);
              if (found) return found;
            }
          }
          return null;
        };

        filename =
          findAttachment(messageResponse.data.payload) || `attachment-${args.attachmentId}`;
      }

      if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
      }

      const fullPath = safeJoinWithinBase(savePath, filename);
      // Update the user-facing filename to the sanitized basename.
      filename = path.basename(filename);
      fs.writeFileSync(fullPath, buffer);

      return {
        content: [
          {
            type: "text",
            text: `Attachment downloaded successfully:\nFile: ${filename}\nSize: ${buffer.length} bytes\nSaved to: ${fullPath}`,
          },
        ],
        structuredContent: {
          status: "saved",
          path: fullPath,
          filename,
          size: buffer.length,
          messageId: args.messageId,
          attachmentId: args.attachmentId,
        },
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Failed to download attachment: ${error.message}` }],
      };
    }
  },
};

registry.register(downloadEmail);
registry.register(downloadAttachment);
