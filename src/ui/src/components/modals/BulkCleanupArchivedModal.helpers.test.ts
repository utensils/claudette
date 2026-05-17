import { describe, it, expect } from "vitest";
import type { Workspace } from "../../types";
import {
  ageBucket,
  filterByAge,
  parseCreatedAt,
} from "./BulkCleanupArchivedModal.helpers";

/** `now` for every test in this file. Fixed so the day/month/year cutoffs
 *  are deterministic and we don't have a flaky test on the boundary of
 *  a real clock tick. */
const NOW = 1_700_000_000;

const DAY = 86_400;

function makeArchived(id: string, ageInDays: number): Workspace {
  return {
    id,
    repository_id: "repo-1",
    name: id,
    branch_name: `feature/${id}`,
    worktree_path: null,
    status: "Archived",
    agent_status: "Stopped",
    status_line: "",
    created_at: String(NOW - ageInDays * DAY),
    sort_order: 0,
    remote_connection_id: null,
  };
}

describe("parseCreatedAt", () => {
  it("returns the numeric epoch for a valid string", () => {
    expect(parseCreatedAt("1700000000")).toBe(1_700_000_000);
  });

  it("returns null for non-numeric values so the row can be skipped under age filters", () => {
    expect(parseCreatedAt("")).toBeNull();
    expect(parseCreatedAt("nope")).toBeNull();
  });
});

describe("ageBucket", () => {
  it("buckets sub-day ages as today", () => {
    expect(ageBucket(String(NOW - 60), NOW)).toEqual({ kind: "today" });
  });

  it("buckets 1-29 days as days with the exact count", () => {
    expect(ageBucket(String(NOW - 5 * DAY), NOW)).toEqual({
      kind: "days",
      count: 5,
    });
    expect(ageBucket(String(NOW - 29 * DAY), NOW)).toEqual({
      kind: "days",
      count: 29,
    });
  });

  it("rolls over to months at 30 days", () => {
    expect(ageBucket(String(NOW - 30 * DAY), NOW)).toEqual({
      kind: "months",
      count: 1,
    });
    expect(ageBucket(String(NOW - 200 * DAY), NOW)).toEqual({
      kind: "months",
      count: 6,
    });
  });

  it("rolls over to years at 365 days", () => {
    expect(ageBucket(String(NOW - 365 * DAY), NOW)).toEqual({
      kind: "years",
      count: 1,
    });
    expect(ageBucket(String(NOW - 800 * DAY), NOW)).toEqual({
      kind: "years",
      count: 2,
    });
  });

  it("clamps negative deltas (created_at in the future) to today", () => {
    expect(ageBucket(String(NOW + 999), NOW)).toEqual({ kind: "today" });
  });

  it("returns null when created_at is unparseable", () => {
    expect(ageBucket("nope", NOW)).toBeNull();
  });
});

describe("filterByAge", () => {
  const workspaces: Workspace[] = [
    makeArchived("fresh", 5),
    makeArchived("midaged", 45),
    makeArchived("old", 120),
    makeArchived("ancient", 400),
  ];

  it("returns every row for filter=all", () => {
    expect(filterByAge(workspaces, "all", NOW).map((w) => w.id)).toEqual([
      "fresh",
      "midaged",
      "old",
      "ancient",
    ]);
  });

  it("returns rows strictly older than N days (exclusive boundary)", () => {
    expect(filterByAge(workspaces, "30", NOW).map((w) => w.id)).toEqual([
      "midaged",
      "old",
      "ancient",
    ]);
    expect(filterByAge(workspaces, "90", NOW).map((w) => w.id)).toEqual([
      "old",
      "ancient",
    ]);
    expect(filterByAge(workspaces, "365", NOW).map((w) => w.id)).toEqual([
      "ancient",
    ]);
  });

  it("excludes rows whose age equals the cutoff exactly (matches 'Older than' label)", () => {
    const exactly30 = makeArchived("exactly30", 30);
    expect(filterByAge([exactly30], "30", NOW).map((w) => w.id)).toEqual([]);
    // One second past the cutoff IS eligible.
    const justOver = makeArchived("over30", 30);
    justOver.created_at = String(NOW - 30 * DAY - 1);
    expect(filterByAge([justOver], "30", NOW).map((w) => w.id)).toEqual([
      "over30",
    ]);
  });

  it("drops rows with unparseable created_at when a window is active", () => {
    const malformed: Workspace = { ...makeArchived("mystery", 0), created_at: "" };
    const all = [...workspaces, malformed];
    expect(filterByAge(all, "all", NOW).some((w) => w.id === "mystery")).toBe(
      true,
    );
    expect(filterByAge(all, "30", NOW).some((w) => w.id === "mystery")).toBe(
      false,
    );
  });
});
