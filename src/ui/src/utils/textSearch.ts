/**
 * Text-search primitives for the in-chat Cmd/Ctrl+F search bar.
 *
 * Kept dependency-free so they can run anywhere in the React tree (and in
 * tests) without pulling in store / DOM context. Both helpers are O(n) over
 * the input text.
 */

export interface MatchRange {
  /** Inclusive start index into the original text. */
  start: number;
  /** Exclusive end index into the original text. */
  end: number;
}

/**
 * Find every case-insensitive substring occurrence of `needle` in `haystack`.
 * Empty needles return no matches (avoids an infinite loop and matches the
 * "no query → no highlight" UX).
 *
 * Matches advance by `needle.length` so overlapping hits aren't double-counted
 * (e.g. searching "aa" in "aaaa" returns 2 matches at indices 0 and 2).
 */
export function findAllRanges(haystack: string, needle: string): MatchRange[] {
  if (!needle) return [];
  if (!haystack) return [];
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const out: MatchRange[] = [];
  let from = 0;
  while (from <= lowerHaystack.length - lowerNeedle.length) {
    const idx = lowerHaystack.indexOf(lowerNeedle, from);
    if (idx === -1) break;
    out.push({ start: idx, end: idx + lowerNeedle.length });
    from = idx + lowerNeedle.length;
  }
  return out;
}

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "match"; text: string; rangeIndex: number };

/**
 * Split `text` into alternating non-match / match segments using the supplied
 * ranges. `rangeIndex` on each match segment carries the position of the
 * range in the input array so callers can map a segment back to a global
 * match index for active-match highlighting.
 *
 * Ranges must be non-overlapping and sorted by `start`. (`findAllRanges`
 * already produces them in that shape.)
 */
export function splitByRanges(text: string, ranges: MatchRange[]): Segment[] {
  if (ranges.length === 0) {
    return text ? [{ kind: "text", text }] : [];
  }
  const out: Segment[] = [];
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.start > cursor) {
      out.push({ kind: "text", text: text.slice(cursor, r.start) });
    }
    out.push({
      kind: "match",
      text: text.slice(r.start, r.end),
      rangeIndex: i,
    });
    cursor = r.end;
  }
  if (cursor < text.length) {
    out.push({ kind: "text", text: text.slice(cursor) });
  }
  return out;
}
