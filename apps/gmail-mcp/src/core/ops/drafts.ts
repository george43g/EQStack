// draft_email op — uses the shared handleEmailAction from send.ts.

import { SendEmailSchema } from "../../tools.js";
import { type Operation, registry } from "../registry.js";
import { handleEmailAction } from "./send.js";

const draftEmail: Operation<unknown> = {
  name: "draft_email",
  schema: SendEmailSchema,
  scopes: ["gmail.modify", "gmail.compose"],
  handler: async (input, ctx) => handleEmailAction("draft", input as any, ctx.gmail),
};

registry.register(draftEmail);
