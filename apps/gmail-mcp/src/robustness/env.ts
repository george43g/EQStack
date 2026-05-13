/**
 * Environment variable helpers for the robustness library.
 *
 * Pure functions, no side effects. All helpers fall back to the provided
 * default when the variable is unset, empty, or fails validation.
 *
 * Convention: robustness knobs use the MCP_ prefix so this module is portable
 * across MCP servers. Project-specific knobs use their own prefix
 * (e.g. GMAIL_) and should not be read through this helper.
 */

export function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const lower = raw.trim().toLowerCase();
  if (TRUTHY.has(lower)) return true;
  if (FALSY.has(lower)) return false;
  return fallback;
}

export function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}
