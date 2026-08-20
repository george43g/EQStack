import { visualWidth } from "@george43g/tui-kit";

// Width-aware counterpart to String#padEnd, which counts UTF-16 code units
// and so mis-pads emoji/CJK strings — the same class of bug truncateToWidth
// fixes. (tui-kit deliberately ships no pad helper; ink flexbox is its
// answer, but our list rows are single concatenated strings.)
export function padToWidth(s: string, cols: number): string {
  return s + " ".repeat(Math.max(0, cols - visualWidth(s)));
}
