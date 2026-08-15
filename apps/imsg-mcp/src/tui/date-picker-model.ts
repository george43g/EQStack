/**
 * Pure state model for the three-field date picker (YYYY / MM / DD).
 * All transitions are pure functions over PickerState so tests can cover the
 * keymap without terminal key translation (ink-testing-library doesn't
 * reliably deliver arrow-key escapes — see tests/date-picker.test.tsx).
 *
 * Digit entry is replace-then-append: the first digit typed into a field
 * REPLACES its value, subsequent digits append; a full field (4 digits for
 * year, 2 for month/day) auto-advances to the next field. The previous
 * shift-and-clamp scheme made most values untypeable: clamping every
 * intermediate (e.g. year 2026 + '1' → 261 → clamp → 1900) meant typing
 * "1999" oscillated between 1900 and 2100, and month 05 + '3' → 53 → 12.
 * Values are allowed to be transiently out of range while typing (month "00"
 * mid-entry); `toIso` clamps at submit.
 */

export type Field = "year" | "month" | "day";
export const FIELD_ORDER: Field[] = ["year", "month", "day"];

export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

const FIELD_WIDTH: Record<Field, number> = { year: 4, month: 2, day: 2 };

export interface PickerState {
  year: number;
  month: number;
  day: number;
  active: Field;
  /** Digits typed into the active field since it became active (0 = next digit replaces). */
  typed: number;
}

export function initPickerState(initial: Date): PickerState {
  return {
    year: initial.getFullYear(),
    month: initial.getMonth() + 1,
    day: initial.getDate(),
    active: "year",
    typed: 0,
  };
}

export function daysInMonth(year: number, monthOneBased: number): number {
  return new Date(year, monthOneBased, 0).getDate();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function fieldValue(s: PickerState, f: Field): number {
  return f === "year" ? s.year : f === "month" ? s.month : s.day;
}

function withField(s: PickerState, f: Field, v: number): PickerState {
  if (f === "year") return { ...s, year: v };
  if (f === "month") return { ...s, month: v };
  return { ...s, day: v };
}

/** Arrow / j-k adjustment: clamped immediately (never leaves a valid range). */
export function adjust(s: PickerState, delta: number): PickerState {
  const f = s.active;
  const v = fieldValue(s, f) + delta;
  let next: PickerState;
  if (f === "year") {
    const y = clamp(v, MIN_YEAR, MAX_YEAR);
    next = { ...s, year: y, day: clamp(s.day, 1, daysInMonth(y, clamp(s.month, 1, 12))) };
  } else if (f === "month") {
    const m = clamp(v, 1, 12);
    next = { ...s, month: m, day: clamp(s.day, 1, daysInMonth(s.year, m)) };
  } else {
    next = { ...s, day: clamp(v, 1, daysInMonth(s.year, clamp(s.month, 1, 12))) };
  }
  return { ...next, typed: 0 };
}

/** ←/→ or h/l: cycle the active field; resets digit-entry state. */
export function moveField(s: PickerState, dir: 1 | -1): PickerState {
  const i = FIELD_ORDER.indexOf(s.active);
  const active = FIELD_ORDER[(i + dir + FIELD_ORDER.length) % FIELD_ORDER.length];
  return { ...s, active, typed: 0 };
}

/**
 * Type one digit into the active field. First digit replaces, later digits
 * append; a full-width field advances to the next one (year → month → day,
 * stopping at day). Out-of-range intermediates are allowed until submit.
 */
export function applyDigit(s: PickerState, digit: number): PickerState {
  const f = s.active;
  const width = FIELD_WIDTH[f];
  const value = s.typed === 0 ? digit : fieldValue(s, f) * 10 + digit;
  const typed = s.typed + 1;
  let next = withField(s, f, value);
  if (typed >= width && f !== "day") {
    next = { ...next, active: FIELD_ORDER[FIELD_ORDER.indexOf(f) + 1], typed: 0 };
  } else {
    next = { ...next, typed };
  }
  return next;
}

/** Apply a burst of digits (Ink delivers fast typing / pastes as one chunk). */
export function applyDigits(s: PickerState, digits: string): PickerState {
  let cur = s;
  for (const ch of digits) cur = applyDigit(cur, Number.parseInt(ch, 10));
  return cur;
}

/** Backspace: drop the last digit of the active field; keeps append mode. */
export function backspaceField(s: PickerState): PickerState {
  const f = s.active;
  const v = Math.floor(fieldValue(s, f) / 10);
  // typed floors at 1 so the next digit APPENDS to the surviving digits —
  // including when backspacing an untouched field (typed 0).
  return { ...withField(s, f, v), typed: Math.max(1, s.typed - 1) };
}

/** Submit: clamp everything into a real calendar date and format as ISO. */
export function toIso(s: PickerState): string {
  const year = clamp(s.year, MIN_YEAR, MAX_YEAR);
  const month = clamp(s.month, 1, 12);
  const day = clamp(s.day, 1, daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
