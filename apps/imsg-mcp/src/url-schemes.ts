/**
 * macOS URL-scheme dispatch helpers.
 *
 * Detects which chat/comms apps are installed in /Applications and builds
 * deep-link URIs that, when passed to `open <uri>`, launch the target app
 * focused on a specific contact. Designed for the TUI's `O` (open in
 * Messages) and `S` (send-via external app) keybinds.
 *
 * Body-carrying support varies by app:
 *   - sms:, whatsapp:, tg:, mailto:  → body/text param honored
 *   - imessage:, sgnl:, facetime:    → recipient only, body stripped
 */

import { existsSync } from "node:fs";

export interface ChatAppDef {
  /** Display name shown in TUI list. */
  name: string;
  /** /Applications/ bundle to probe. */
  appPath: string;
  /** Build the URL given a handle + optional body text. Returns null if the
   *  handle isn't compatible (e.g. Signal can't take an email). */
  buildUri: (handle: string, body?: string) => string | null;
  /** True if `body` is honored by the URL scheme. */
  supportsBody: boolean;
}

const APPS: ChatAppDef[] = [
  {
    name: "Messages",
    appPath: "/System/Applications/Messages.app",
    buildUri: (handle) => `imessage://${encodeURIComponent(handle)}`,
    supportsBody: false,
  },
  {
    name: "FaceTime",
    appPath: "/System/Applications/FaceTime.app",
    buildUri: (handle) => `facetime://${encodeURIComponent(handle)}`,
    supportsBody: false,
  },
  {
    name: "FaceTime Audio",
    appPath: "/System/Applications/FaceTime.app",
    buildUri: (handle) => `facetime-audio://${encodeURIComponent(handle)}`,
    supportsBody: false,
  },
  {
    name: "Signal",
    appPath: "/Applications/Signal.app",
    buildUri: (handle) => {
      // Signal only accepts phone numbers.
      const phone = handle.replace(/[^\d+]/g, "");
      if (!phone || !phone.startsWith("+")) return null;
      return `sgnl://send?phone=${encodeURIComponent(phone)}`;
    },
    supportsBody: false,
  },
  {
    name: "WhatsApp",
    appPath: "/Applications/WhatsApp.app",
    buildUri: (handle, body) => {
      const phone = handle.replace(/[^\d+]/g, "").replace(/^\+/, "");
      if (!phone) return null;
      const base = `whatsapp://send?phone=${encodeURIComponent(phone)}`;
      return body ? `${base}&text=${encodeURIComponent(body)}` : base;
    },
    supportsBody: true,
  },
  {
    name: "Telegram",
    appPath: "/Applications/Telegram.app",
    buildUri: (handle, body) => {
      const phone = handle.replace(/[^\d+]/g, "");
      if (!phone) return null;
      const base = `tg://resolve?phone=${encodeURIComponent(phone)}`;
      return body ? `${base}&text=${encodeURIComponent(body)}` : base;
    },
    supportsBody: true,
  },
  {
    name: "SMS",
    appPath: "/System/Applications/Messages.app",
    buildUri: (handle, body) => {
      // sms: works for both numbers and email (Messages.app fallback).
      const base = `sms:${encodeURIComponent(handle)}`;
      return body ? `${base}&body=${encodeURIComponent(body)}` : base;
    },
    supportsBody: true,
  },
];

/**
 * Return the apps installed on this Mac, in the order they're declared.
 * Messages and FaceTime are typically always present; third-party apps
 * (Signal, WhatsApp, Telegram) require the app to be installed.
 */
export function getInstalledChatApps(): ChatAppDef[] {
  return APPS.filter((a) => existsSync(a.appPath));
}

/**
 * Build the right URI for a specific app by name (case-insensitive). Returns
 * null if the app is not installed OR the handle isn't compatible with the
 * app's URL scheme.
 */
export function buildChatAppUri(
  appName: string,
  handle: string,
  body?: string,
): { uri: string; supportsBody: boolean } | null {
  const lower = appName.toLowerCase();
  const app = APPS.find((a) => a.name.toLowerCase() === lower);
  if (!app) return null;
  if (!existsSync(app.appPath)) return null;
  const uri = app.buildUri(handle, body);
  if (!uri) return null;
  return { uri, supportsBody: app.supportsBody };
}
