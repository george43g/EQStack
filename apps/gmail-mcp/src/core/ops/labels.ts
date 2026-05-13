// Label-management ops: list_email_labels + 4 CRUD ops.
// Wraps the existing low-level helpers in src/label-manager.ts.

import {
  createLabel,
  deleteLabel,
  type GmailLabel,
  getOrCreateLabel,
  listLabels,
  updateLabel,
} from "../../label-manager.js";
import {
  CreateLabelSchema,
  DeleteLabelSchema,
  GetOrCreateLabelSchema,
  ListEmailLabelsSchema,
  UpdateLabelSchema,
} from "../../tools.js";
import { type Operation, registry } from "../registry.js";

const listEmailLabels: Operation<unknown> = {
  name: "list_email_labels",
  schema: ListEmailLabelsSchema,
  scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
  handler: async (_input, ctx) => {
    const labelResults = await listLabels(ctx.gmail);
    const systemLabels = labelResults.system;
    const userLabels = labelResults.user;

    return {
      content: [
        {
          type: "text",
          text:
            `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
            "System Labels:\n" +
            systemLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join("\n") +
            "\nUser Labels:\n" +
            userLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join("\n"),
        },
      ],
    };
  },
};

const createLabelOp: Operation<unknown> = {
  name: "create_label",
  schema: CreateLabelSchema,
  scopes: ["gmail.modify", "gmail.labels"],
  handler: async (input, ctx) => {
    const args = input as {
      name: string;
      messageListVisibility?: string;
      labelListVisibility?: string;
    };
    const result = await createLabel(ctx.gmail, args.name, {
      messageListVisibility: args.messageListVisibility,
      labelListVisibility: args.labelListVisibility,
    });
    return {
      content: [
        {
          type: "text",
          text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
        },
      ],
    };
  },
};

const updateLabelOp: Operation<unknown> = {
  name: "update_label",
  schema: UpdateLabelSchema,
  scopes: ["gmail.modify", "gmail.labels"],
  handler: async (input, ctx) => {
    const args = input as {
      id: string;
      name?: string;
      messageListVisibility?: string;
      labelListVisibility?: string;
    };
    const updates: { name?: string; messageListVisibility?: string; labelListVisibility?: string } =
      {};
    if (args.name) updates.name = args.name;
    if (args.messageListVisibility) updates.messageListVisibility = args.messageListVisibility;
    if (args.labelListVisibility) updates.labelListVisibility = args.labelListVisibility;

    const result = await updateLabel(ctx.gmail, args.id, updates);
    return {
      content: [
        {
          type: "text",
          text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
        },
      ],
    };
  },
};

const deleteLabelOp: Operation<unknown> = {
  name: "delete_label",
  schema: DeleteLabelSchema,
  scopes: ["gmail.modify", "gmail.labels"],
  handler: async (input, ctx) => {
    const args = input as { id: string };
    const result = await deleteLabel(ctx.gmail, args.id);
    return {
      content: [{ type: "text", text: result.message }],
    };
  },
};

const getOrCreateLabelOp: Operation<unknown> = {
  name: "get_or_create_label",
  schema: GetOrCreateLabelSchema,
  scopes: ["gmail.modify", "gmail.labels"],
  handler: async (input, ctx) => {
    const args = input as {
      name: string;
      messageListVisibility?: string;
      labelListVisibility?: string;
    };
    const result = await getOrCreateLabel(ctx.gmail, args.name, {
      messageListVisibility: args.messageListVisibility,
      labelListVisibility: args.labelListVisibility,
    });

    const action =
      result.type === "user" && result.name === args.name ? "found existing" : "created new";

    return {
      content: [
        {
          type: "text",
          text: `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
        },
      ],
    };
  },
};

registry.register(listEmailLabels);
registry.register(createLabelOp);
registry.register(updateLabelOp);
registry.register(deleteLabelOp);
registry.register(getOrCreateLabelOp);
