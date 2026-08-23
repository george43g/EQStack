/**
 * Date bounds for a TUI export, derived from the messages the user selected.
 *
 * The TUI decides the RANGE; the DB decides what is in it. Exports stream from
 * `streamExport`, so anything the bounded-memory window evicted is re-read
 * rather than silently dropped from the user's file.
 *
 * ⚠️ The 1ms widening is load-bearing, not defensive padding. The export query
 * compares Mac NANOSECONDS (`m.date >= ?` / `<= ?`) and `dateToMacTimestamp`
 * floors a JS Date, which only carries milliseconds — so a row stored at
 * …959_123_456ns round-trips to …959_000_000ns and an exact `until` bound
 * excludes the very message the user selected last. Measured 2026-08-23: a
 * 10-row selection exported 9, the missing one being exactly the `until`
 * endpoint. Widening by one tick of a Date's finest resolution puts both
 * endpoints inside. Over-inclusion by an adjacent row within the same
 * millisecond is the safe direction; silent omission is what this replaces.
 */

export interface ExportBounds {
  since: Date;
  until: Date;
}

/**
 * @param scope the selected messages, ascending by date (as `state.messages` is)
 * @returns inclusive-safe bounds, or null when there is nothing to export
 */
export function exportBounds(scope: ReadonlyArray<{ date: Date }>): ExportBounds | null {
  if (scope.length === 0) return null;
  const first = scope[0];
  const last = scope[scope.length - 1];
  if (first === undefined || last === undefined) return null;
  // Guard against a caller handing us a descending slice: the query needs
  // since <= until or it matches nothing at all.
  const lo = Math.min(first.date.getTime(), last.date.getTime());
  const hi = Math.max(first.date.getTime(), last.date.getTime());
  return { since: new Date(lo - 1), until: new Date(hi + 1) };
}
