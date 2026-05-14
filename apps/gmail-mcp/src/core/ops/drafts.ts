// draft_email op — uses the shared handleEmailAction from send.ts.

import { SendEmailSchema, SendOrDraftOutputSchema } from "../../tools.js";
import { type Operation, registry } from "../registry.js";
import { handleEmailAction, type SendOrDraftOutput } from "./send.js";

const draftEmail: Operation<unknown, SendOrDraftOutput> = {
  name: "draft_email",
  schema: SendEmailSchema,
  outputSchema: SendOrDraftOutputSchema,
  scopes: ["gmail.modify", "gmail.compose"],
  handler: async (input, ctx) => handleEmailAction("draft", input as any, ctx.gmail),
};

registry.register(draftEmail);
