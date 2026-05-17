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

/** Parse the `created_at` field into Unix seconds. Two formats are
 *  observed in the wild:
 *
 *  1. **SQLite `datetime('now')`** — `"YYYY-MM-DD HH:MM:SS"` (UTC).
 *     This is what the `workspaces` table actually stores: the
 *     `INSERT` in `Database::insert_workspace` omits `created_at`,
 *     so the column `DEFAULT (datetime('now'))` fills in.
 *  2. **Unix-seconds-as-string** — `"1700000000"`. What
 *     `ops::workspace::now_iso()` produces. Unused for
 *     `workspaces.created_at` today, but several siblings use it,
 *     and a future migration that switches the INSERT to set
 *     `created_at = now_iso()` shouldn't require a frontend
 *     change to keep working.
 *  3. **ISO 8601 with `T`/timezone** — `"2026-05-15T19:23:11Z"`.
 *     Future-proof for callers that adopt the standard form.
 *
 *  Returns `null` for malformed values so callers can decide
 *  whether to keep or drop the row. A naive `parseInt` would
 *  silently misread the leading `"2026"` from format 1 as a
 *  ~33-minute-old Unix timestamp (rendering every workspace as
 *  "56y ago") — hence the explicit format detection. */
export function parseCreatedAt(value: string): number | null {
  if (!value) return null;

  // All-digits → Unix seconds.
  if (/^\d+$/.test(value)) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }

  // SQLite `datetime('now')` lacks a timezone suffix — the value is
  // UTC, so swap the space for `T` and tack on `Z` before handing it
  // to the platform parser. Already-ISO values pass through.
  const normalized = (() => {
    const withT = value.includes("T") ? value : value.replace(" ", "T");
    const hasTz = /[Zz]|[+-]\d{2}:?\d{2}$/.test(withT);
    return hasTz ? withT : `${withT}Z`;
  })();
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
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
