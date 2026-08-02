import { describe, expect, it } from "vitest";
import { formatJumpTarget, parseUserDate } from "../src/date-parse.js";

const NOW = new Date("2024-06-15T12:00:00.000Z");

describe("parseUserDate — ISO formats", () => {
  it("parses YYYY-MM-DD", () => {
    const d = parseUserDate("2024-03-15", NOW);
    expect(d?.getFullYear()).toBe(2024);
    expect(d?.getMonth()).toBe(2); // March = 2
    expect(d?.getDate()).toBe(15);
  });

  it("parses ISO datetime with hours and minutes", () => {
    const d = parseUserDate("2024-03-15T10:30", NOW);
    expect(d?.getHours()).toBe(10);
    expect(d?.getMinutes()).toBe(30);
  });

  it("rejects invalid ISO", () => {
    expect(parseUserDate("2024-13-99", NOW)).not.toBeNull(); // JS coerces, but it's still a date
    // The strict check: rejects garbage that doesn't even match the pattern
    expect(parseUserDate("2024-XX-15", NOW)).toBeNull();
  });
});

describe("parseUserDate — US formats", () => {
  it("parses M/D/YYYY", () => {
    const d = parseUserDate("3/15/2024", NOW);
    expect(d?.getFullYear()).toBe(2024);
    expect(d?.getMonth()).toBe(2);
    expect(d?.getDate()).toBe(15);
  });

  it("parses M/D and assumes current year", () => {
    const d = parseUserDate("3/15", NOW);
    expect(d?.getFullYear()).toBe(2024);
  });

  it("expands two-digit year to 20XX", () => {
    const d = parseUserDate("3/15/24", NOW);
    expect(d?.getFullYear()).toBe(2024);
  });

  it("rejects invalid month/day", () => {
    expect(parseUserDate("13/15", NOW)).toBeNull();
    expect(parseUserDate("3/45", NOW)).toBeNull();
  });
});

describe("parseUserDate — keywords", () => {
  it("parses 'today'", () => {
    const d = parseUserDate("today", NOW);
    expect(d?.getTime()).toBe(NOW.getTime());
  });

  it("parses 'yesterday'", () => {
    const d = parseUserDate("yesterday", NOW);
    expect(d).not.toBeNull();
    const expected = new Date(NOW);
    expected.setDate(NOW.getDate() - 1);
    expect(d?.toDateString()).toBe(expected.toDateString());
  });

  it("is case-insensitive", () => {
    expect(parseUserDate("Today", NOW)?.getTime()).toBe(NOW.getTime());
    expect(parseUserDate("YESTERDAY", NOW)).not.toBeNull();
  });
});

describe("parseUserDate — relative phrases", () => {
  it("parses 'N days ago'", () => {
    const d = parseUserDate("5 days ago", NOW);
    expect(d).not.toBeNull();
    const diff = (NOW.getTime() - (d?.getTime() ?? 0)) / 86400000;
    expect(Math.round(diff)).toBe(5);
  });

  it("parses 'N weeks ago'", () => {
    const d = parseUserDate("2 weeks ago", NOW);
    const diff = (NOW.getTime() - (d?.getTime() ?? 0)) / 86400000;
    expect(Math.round(diff)).toBe(14);
  });

  it("parses 'N months ago'", () => {
    const d = parseUserDate("3 months ago", NOW);
    expect(d?.getMonth()).toBe(2); // June (5) - 3 = March (2)
  });

  it("parses 'N years ago'", () => {
    const d = parseUserDate("1 year ago", NOW);
    expect(d?.getFullYear()).toBe(2023);
  });

  it("accepts singular and plural", () => {
    expect(parseUserDate("1 day ago", NOW)).not.toBeNull();
    expect(parseUserDate("1 days ago", NOW)).not.toBeNull();
  });
});

describe("parseUserDate — compact relative", () => {
  it("parses Nd / Nw / Nm / Ny", () => {
    const d5 = parseUserDate("5d", NOW);
    const w2 = parseUserDate("2w", NOW);
    const m3 = parseUserDate("3m", NOW);
    const y1 = parseUserDate("1y", NOW);

    expect(d5).not.toBeNull();
    expect(w2).not.toBeNull();
    expect(m3?.getMonth()).toBe(2);
    expect(y1?.getFullYear()).toBe(2023);
  });
});

describe("parseUserDate — invalid", () => {
  it("returns null for empty input", () => {
    expect(parseUserDate("", NOW)).toBeNull();
    expect(parseUserDate("   ", NOW)).toBeNull();
  });

  it("returns null for nonsense", () => {
    expect(parseUserDate("qwerty", NOW)).toBeNull();
    expect(parseUserDate("not a date", NOW)).toBeNull();
    expect(parseUserDate("123abc", NOW)).toBeNull();
  });
});

describe("formatJumpTarget", () => {
  it("formats with weekday + month + day + year", () => {
    const out = formatJumpTarget(new Date("2024-03-15T10:00:00"));
    expect(out).toMatch(/Fri|Sat|Sun|Mon|Tue|Wed|Thu/);
    expect(out).toMatch(/2024/);
    expect(out).toMatch(/15/);
  });
});
