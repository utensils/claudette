import { describe, it, expect } from "vitest";
import type { Workspace } from "../../types";
import {
  ageLabel,
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

describe("ageLabel", () => {
  it("renders today for sub-day ages", () => {
    expect(ageLabel(String(NOW - 60), NOW)).toBe("today");
  });

  it("renders Nd ago between 1 and 29 days", () => {
    expect(ageLabel(String(NOW - 5 * DAY), NOW)).toBe("5d ago");
    expect(ageLabel(String(NOW - 29 * DAY), NOW)).toBe("29d ago");
  });

  it("rolls over to months at 30 days", () => {
    expect(ageLabel(String(NOW - 30 * DAY), NOW)).toBe("1mo ago");
    expect(ageLabel(String(NOW - 200 * DAY), NOW)).toBe("6mo ago");
  });

  it("rolls over to years at 365 days", () => {
    expect(ageLabel(String(NOW - 365 * DAY), NOW)).toBe("1y ago");
    expect(ageLabel(String(NOW - 800 * DAY), NOW)).toBe("2y ago");
  });

  it("clamps negative deltas (created_at in the future) to today", () => {
    expect(ageLabel(String(NOW + 999), NOW)).toBe("today");
  });

  it("returns an empty string when created_at is unparseable", () => {
    expect(ageLabel("nope", NOW)).toBe("");
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

  it("returns rows strictly older than the chosen window", () => {
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
