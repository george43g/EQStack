// Typed in-process Gmail dispatch hooks. Wraps `callOp` from cli/runtime so
// every TUI surface gets fully-typed payloads via the B2 outputSchemas. No
// React state lives here — callers manage their own state via the reducer.

import type { z } from "zod";
import { callOp } from "../../cli/runtime.js";
import type {
  GetThreadOutputSchema,
  ListAccountsOutputSchema,
  ListEmailLabelsOutputSchema,
  ListInboxThreadsOutputSchema,
  ReadEmailOutputSchema,
  SearchEmailsOutputSchema,
  SwitchAccountOutputSchema,
} from "../../tools.js";

export type LabelList = z.infer<typeof ListEmailLabelsOutputSchema>;
export type ThreadList = z.infer<typeof ListInboxThreadsOutputSchema>;
export type ThreadView = z.infer<typeof GetThreadOutputSchema>;
export type EmailView = z.infer<typeof ReadEmailOutputSchema>;
export type SearchResults = z.infer<typeof SearchEmailsOutputSchema>;
export type AccountList = z.infer<typeof ListAccountsOutputSchema>;
export type SwitchAccountResult = z.infer<typeof SwitchAccountOutputSchema>;

export function listLabels(signal?: AbortSignal): Promise<LabelList> {
  return callOp<LabelList>("list_email_labels", {}, signal);
}

export function listInboxThreads(
  opts: { query?: string; maxResults?: number } = {},
  signal?: AbortSignal,
): Promise<ThreadList> {
  return callOp<ThreadList>(
    "list_inbox_threads",
    { query: opts.query, maxResults: opts.maxResults ?? 50 },
    signal,
  );
}

export function getThread(threadId: string, signal?: AbortSignal): Promise<ThreadView> {
  return callOp<ThreadView>("get_thread", { threadId, format: "full" }, signal);
}

export function readEmail(messageId: string, signal?: AbortSignal): Promise<EmailView> {
  return callOp<EmailView>("read_email", { messageId }, signal);
}

export function searchEmails(
  query: string,
  maxResults = 50,
  signal?: AbortSignal,
): Promise<SearchResults> {
  return callOp<SearchResults>("search_emails", { query, maxResults }, signal);
}

export function listAccounts(signal?: AbortSignal): Promise<AccountList> {
  return callOp<AccountList>("list_accounts", {}, signal);
}

export function switchAccount(
  accountId: string,
  signal?: AbortSignal,
): Promise<SwitchAccountResult> {
  return callOp<SwitchAccountResult>("switch_account", { accountId }, signal);
}
