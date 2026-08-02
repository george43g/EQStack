/**
 * Pure date parser for user input. Returns a Date or null if unparseable.
 *
 * Supported formats (case-insensitive, leading/trailing whitespace ignored):
 *   - ISO date:        2024-03-15
 *   - ISO datetime:    2024-03-15T10:30
 *   - US date:         3/15/2024  or  3/15  (assumes current year)
 *   - Keywords:        today, yesterday, now
 *   - Relative phrases:
 *       N day(s) ago, N week(s) ago, N month(s) ago, N year(s) ago
 *   - Compact relative: Nd, Nw, Nm, Ny  (always relative to "now", in the past)
 *
 * No external deps. Edge cases tested in tests/date-parse.test.ts.
 */

export function parseUserDate(input: string, now: Date = new Date()): Date | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  // Keywords
  if (raw === "today" || raw === "now") return new Date(now);
  if (raw === "yesterday") {
    const d = new Date(now);
    d.setDate(now.getDate() - 1);
    return d;
  }

  // ISO datetime: 2024-03-15T10:30 or 2024-03-15
  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:t(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (isoMatch) {
    const [, y, m, d, hh, mm] = isoMatch;
    const date = new Date(
      Number.parseInt(y, 10),
      Number.parseInt(m, 10) - 1,
      Number.parseInt(d, 10),
      hh ? Number.parseInt(hh, 10) : 0,
      mm ? Number.parseInt(mm, 10) : 0,
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // US date: M/D/YYYY or M/D (assume current year)
  const usMatch = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    const month = Number.parseInt(m, 10);
    const day = Number.parseInt(d, 10);
    let year = y ? Number.parseInt(y, 10) : now.getFullYear();
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(year, month - 1, day);
  }

  // Relative phrases: "N <unit> ago"
  const phraseMatch = raw.match(/^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/);
  if (phraseMatch) {
    const n = Number.parseInt(phraseMatch[1], 10);
    return applyRelative(now, n, phraseMatch[2][0]); // first letter is enough
  }

  // Compact: 5d, 2w, 3m, 1y
  const compactMatch = raw.match(/^(\d+)([dwmy])$/);
  if (compactMatch) {
    const n = Number.parseInt(compactMatch[1], 10);
    return applyRelative(now, n, compactMatch[2]);
  }

  return null;
}

function applyRelative(now: Date, n: number, unit: string): Date {
  const d = new Date(now);
  switch (unit) {
    case "d":
      d.setDate(d.getDate() - n);
      break;
    case "w":
      d.setDate(d.getDate() - n * 7);
      break;
    case "m":
      d.setMonth(d.getMonth() - n);
      break;
    case "y":
      d.setFullYear(d.getFullYear() - n);
      break;
  }
  return d;
}

/** Pretty-format a target date for status messages. */
export function formatJumpTarget(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
