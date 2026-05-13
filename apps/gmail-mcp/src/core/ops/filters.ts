// Filter management ops. Wraps src/filter-manager.ts low-level helpers.

import {
  createFilter,
  deleteFilter,
  filterTemplates,
  getFilter,
  listFilters,
} from "../../filter-manager.js";
import {
  CreateFilterFromTemplateSchema,
  CreateFilterSchema,
  DeleteFilterSchema,
  GetFilterSchema,
  ListEmailLabelsSchema,
} from "../../tools.js";
import { type Operation, registry } from "../registry.js";

const createFilterOp: Operation<unknown> = {
  name: "create_filter",
  schema: CreateFilterSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (input, ctx) => {
    const args = input as { criteria: any; action: any };
    const result = await createFilter(ctx.gmail, args.criteria, args.action);

    const criteriaText = Object.entries(args.criteria)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");

    const actionText = Object.entries(args.action)
      .filter(
        ([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
      )
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join(", ");

    return {
      content: [
        {
          type: "text",
          text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
        },
      ],
    };
  },
};

const listFiltersOp: Operation<unknown> = {
  name: "list_filters",
  // No dedicated schema in tools.ts — list_filters takes no args. Reuse the
  // empty schema used by list_email_labels for shape parity.
  schema: ListEmailLabelsSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (_input, ctx) => {
    const result = await listFilters(ctx.gmail);
    const filters = result.filters;

    if (filters.length === 0) {
      return { content: [{ type: "text", text: "No filters found." }] };
    }

    const filtersText = filters
      .map((filter: any) => {
        const criteriaEntries = Object.entries(filter.criteria || {})
          .filter(([_, value]) => value !== undefined)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ");

        const actionEntries = Object.entries(filter.action || {})
          .filter(
            ([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
          )
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
          .join(", ");

        return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
      })
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${result.count} filters:\n\n${filtersText}`,
        },
      ],
    };
  },
};

const getFilterOp: Operation<unknown> = {
  name: "get_filter",
  schema: GetFilterSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (input, ctx) => {
    const args = input as { filterId: string };
    const result = await getFilter(ctx.gmail, args.filterId);

    const criteriaText = Object.entries(result.criteria || {})
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");

    const actionText = Object.entries(result.action || {})
      .filter(
        ([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true),
      )
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join(", ");

    return {
      content: [
        {
          type: "text",
          text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
        },
      ],
    };
  },
};

const deleteFilterOp: Operation<unknown> = {
  name: "delete_filter",
  schema: DeleteFilterSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (input, ctx) => {
    const args = input as { filterId: string };
    const result = await deleteFilter(ctx.gmail, args.filterId);
    return { content: [{ type: "text", text: result.message }] };
  },
};

const createFilterFromTemplate: Operation<unknown> = {
  name: "create_filter_from_template",
  schema: CreateFilterFromTemplateSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (input, ctx) => {
    const args = input as { template: string; parameters: any };
    const template = args.template;
    const params = args.parameters;

    let filterConfig: { criteria: any; action: any };
    switch (template) {
      case "fromSender":
        if (!params.senderEmail) throw new Error("senderEmail is required for fromSender template");
        filterConfig = filterTemplates.fromSender(
          params.senderEmail,
          params.labelIds,
          params.archive,
        );
        break;
      case "withSubject":
        if (!params.subjectText)
          throw new Error("subjectText is required for withSubject template");
        filterConfig = filterTemplates.withSubject(
          params.subjectText,
          params.labelIds,
          params.markAsRead,
        );
        break;
      case "withAttachments":
        filterConfig = filterTemplates.withAttachments(params.labelIds);
        break;
      case "largeEmails":
        if (!params.sizeInBytes)
          throw new Error("sizeInBytes is required for largeEmails template");
        filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
        break;
      case "containingText":
        if (!params.searchText)
          throw new Error("searchText is required for containingText template");
        filterConfig = filterTemplates.containingText(
          params.searchText,
          params.labelIds,
          params.markImportant,
        );
        break;
      case "mailingList":
        if (!params.listIdentifier)
          throw new Error("listIdentifier is required for mailingList template");
        filterConfig = filterTemplates.mailingList(
          params.listIdentifier,
          params.labelIds,
          params.archive,
        );
        break;
      default:
        throw new Error(`Unknown template: ${template}`);
    }

    const result = await createFilter(ctx.gmail, filterConfig.criteria, filterConfig.action);
    return {
      content: [
        {
          type: "text",
          text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`,
        },
      ],
    };
  },
};

registry.register(createFilterOp);
registry.register(listFiltersOp);
registry.register(getFilterOp);
registry.register(deleteFilterOp);
registry.register(createFilterFromTemplate);
