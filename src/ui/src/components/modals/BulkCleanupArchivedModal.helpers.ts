import type { Workspace } from "../../types";

/**
 * Pure helpers for `BulkCleanupArchivedModal`. Extracted so the age filter
 * and the age bucketing can be unit-tested without spinning up the modal.
 * The modal-as-a-whole isn't worth a full render test for the payoff (we
 * already test the store action `removeWorkspace` separately).
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

/** Discriminated union the modal renders into a localized label. Kept
 *  data-only so tests can assert the bucket without depending on i18n
 *  string output and so future locales render in the user's language
 *  without code changes. */
export type AgeBucket =
  | { kind: "today" }
  | { kind: "days"; count: number }
  | { kind: "months"; count: number }
  | { kind: "years"; count: number };

/** Parse the `created_at` Unix-seconds-as-string field (set by
 *  `ops::workspace::now_iso`). Returns `null` for malformed values so
 *  callers can decide whether to keep or drop the row. */
export function parseCreatedAt(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** Bucket `created_at` into today / days / months / years, anchored at
 *  `nowSecs` (frozen at modal mount so the column doesn't tick
 *  mid-interaction). `null` when the timestamp won't parse — better
 *  than rendering `NaN`. */
export function ageBucket(createdAt: string, nowSecs: number): AgeBucket | null {
  const created = parseCreatedAt(createdAt);
  if (created === null) return null;
  const seconds = Math.max(0, nowSecs - created);
  const days = Math.floor(seconds / 86_400);
  if (days < 1) return { kind: "today" };
  if (days < 30) return { kind: "days", count: days };
  if (days < 365) return { kind: "months", count: Math.floor(days / 30) };
  return { kind: "years", count: Math.floor(days / 365) };
}

/** Filter the archived list by the chosen age window. The user-facing
 *  label is "Older than N days" so the boundary is strictly exclusive
 *  — a row aged exactly N days is NOT eligible under the `N` filter.
 *  Rows whose `created_at` won't parse are dropped when a window is
 *  active — better to omit one mystery row than risk hard-deleting it
 *  under a filter the user can't actually verify. */
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
    return c !== null && c < cutoffSecs;
  });
}
