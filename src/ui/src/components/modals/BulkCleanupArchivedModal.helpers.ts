import type { Workspace } from "../../types";

/**
 * Pure helpers for `BulkCleanupArchivedModal`. Extracted so the age filter
 * and the human-readable age label can be unit-tested without spinning up
 * the modal — the modal-as-a-whole isn't worth a full render test for the
 * payoff (we already test the store action `removeWorkspace` separately).
 */

export type AgeFilter = "all" | "30" | "60" | "90" | "180" | "365";

export const AGE_FILTERS: { key: AgeFilter; days: number | null }[] = [
  { key: "all", days: null },
  { key: "30", days: 30 },
  { key: "60", days: 60 },
  { key: "90", days: 90 },
  { key: "180", days: 180 },
  { key: "365", days: 365 },
];

/** Parse the `created_at` Unix-seconds-as-string field (set by
 *  `ops::workspace::now_iso`). Returns `null` for malformed values so
 *  callers can decide whether to keep or drop the row. */
export function parseCreatedAt(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Human-readable age, anchored at `nowSecs` (frozen at modal mount so
 *  the column doesn't tick mid-interaction). Falls back to an empty
 *  string when `created_at` won't parse — better than rendering `NaN`. */
export function ageLabel(createdAt: string, nowSecs: number): string {
  const created = parseCreatedAt(createdAt);
  if (created === null) return "";
  const seconds = Math.max(0, nowSecs - created);
  const days = Math.floor(seconds / 86_400);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Filter the archived list by the chosen age window. Rows whose
 *  `created_at` won't parse are dropped when a window is active —
 *  better to omit one mystery row than risk hard-deleting it under
 *  a "30 days" filter the user can't actually verify. */
export function filterByAge(
  workspaces: Workspace[],
  ageFilter: AgeFilter,
  nowSecs: number,
): Workspace[] {
  const cutoffDays = AGE_FILTERS.find((f) => f.key === ageFilter)?.days ?? null;
  if (cutoffDays === null) return workspaces;
  const cutoffSecs = nowSecs - cutoffDays * 86_400;
  return workspaces.filter((w) => {
    const c = parseCreatedAt(w.created_at);
    return c !== null && c <= cutoffSecs;
  });
}
