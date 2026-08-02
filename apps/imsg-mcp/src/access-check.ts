import { existsSync } from "node:fs";
import os from "node:os";
import { checkMessagesAvailable } from "./applescript.js";
import { getContactsDbPaths, getImsgDbPath } from "./config.js";
import Database from "./sqlite.js";

export type AccessStatus = "ok" | "warn" | "error";

export interface AccessCheckItem {
  key: string;
  label: string;
  status: AccessStatus;
  detail: string;
}

export interface AccessReport {
  ok: boolean;
  items: AccessCheckItem[];
}

function inspectSqlite(path: string): string | null {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("schema_version");
    return null;
  } finally {
    db.close();
  }
}

function classifyDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/operation not permitted/i.test(message) || /authorization denied/i.test(message)) {
    return [
      "Full Disk Access is missing for the app running this command.",
      "Grant Full Disk Access to Terminal, iTerm2, Warp, VS Code, Cursor, or whichever app is launching imsg-mcp, then fully restart that app.",
      "Open System Settings -> Privacy & Security -> Full Disk Access.",
    ].join(" ");
  }
  if (/unable to open database file/i.test(message) || /no such file/i.test(message)) {
    return "Database file was not found at the configured path.";
  }
  return message;
}

function iconFor(status: AccessStatus): string {
  if (status === "ok") return "OK";
  if (status === "warn") return "WARN";
  return "ERR";
}

export async function checkLocalAccess(): Promise<AccessReport> {
  const items: AccessCheckItem[] = [];

  items.push({
    key: "platform",
    label: "Platform",
    status: process.platform === "darwin" ? "ok" : "error",
    detail:
      process.platform === "darwin"
        ? `Running on macOS ${os.release()}`
        : `Running on ${process.platform}; live iMessage access only works on macOS.`,
  });

  const imsgDbPath = getImsgDbPath();
  if (!existsSync(imsgDbPath)) {
    items.push({
      key: "messages-db",
      label: "Messages DB",
      status: "error",
      detail: `Missing ${imsgDbPath}`,
    });
  } else {
    try {
      const error = inspectSqlite(imsgDbPath);
      items.push({
        key: "messages-db",
        label: "Messages DB",
        status: error ? "error" : "ok",
        detail: error ? classifyDbError(error) : `Readable at ${imsgDbPath}`,
      });
    } catch (error) {
      items.push({
        key: "messages-db",
        label: "Messages DB",
        status: "error",
        detail: classifyDbError(error),
      });
    }
  }

  const contactPaths = getContactsDbPaths() ?? [];
  const existingContactPaths = contactPaths.filter((path) => existsSync(path));
  if (existingContactPaths.length === 0) {
    items.push({
      key: "contacts-db",
      label: "Contacts DB",
      status: "warn",
      detail:
        "No readable Address Book database was found. Message reads still work, but names may stay as raw phone numbers or emails.",
    });
  } else {
    const failures: string[] = [];
    for (const path of existingContactPaths) {
      try {
        inspectSqlite(path);
      } catch (error) {
        failures.push(`${path}: ${classifyDbError(error)}`);
      }
    }
    items.push({
      key: "contacts-db",
      label: "Contacts DB",
      status: failures.length === 0 ? "ok" : "warn",
      detail:
        failures.length === 0
          ? `Readable at ${existingContactPaths.join(", ")}`
          : `Some contact databases are unreadable. ${failures.join(" ")}`,
    });
  }

  const messagesRunning = await checkMessagesAvailable().catch(() => false);
  items.push({
    key: "messages-app",
    label: "Messages.app",
    status: messagesRunning ? "ok" : "warn",
    detail: messagesRunning
      ? "Messages.app is running."
      : "Messages.app is not running. Reading still works, but sending requires Messages.app to be open.",
  });

  return {
    ok: items.every((item) => item.status !== "error"),
    items,
  };
}

export function formatAccessReport(report: AccessReport): string {
  const lines = ["imsg-mcp doctor", ""];
  for (const item of report.items) {
    lines.push(`${iconFor(item.status)}  ${item.label}`);
    lines.push(`    ${item.detail}`);
  }
  lines.push("");
  lines.push(
    report.ok
      ? "Environment looks ready for local message reads."
      : "Fix the ERR items above, then rerun `imsg doctor`.",
  );
  return lines.join("\n");
}
