import { describe, it, expect } from "vitest";
import type { Repository, Workspace } from "../../types";
import {
  ageBucket,
  filterByAge,
  groupByRepository,
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
  it("returns the numeric epoch for an all-digits Unix-seconds string", () => {
    expect(parseCreatedAt("1700000000")).toBe(1_700_000_000);
  });

  it("parses SQLite `datetime('now')` output as UTC", () => {
    // datetime('now') returns "YYYY-MM-DD HH:MM:SS" with no timezone
    // suffix; the value is UTC. The DB column DEFAULT is datetime('now'),
    // which is what `workspaces.created_at` actually holds today
    // because `insert_workspace` omits the column from its INSERT.
    expect(parseCreatedAt("2023-11-14 22:13:20")).toBe(1_700_000_000);
  });

  it("parses ISO 8601 with explicit Z / T", () => {
    expect(parseCreatedAt("2023-11-14T22:13:20Z")).toBe(1_700_000_000);
  });

  it("returns null for unparseable values so the row can be skipped under age filters", () => {
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

  it("pins the months→years boundary at exactly 365 days", () => {
    // 364 days stays in `months` (math: floor(364/30) = 12, so the
    // label reads "12mo ago"). Day 365 promotes to `years`. The
    // jump from `12mo ago` straight to `1y ago` (skipping "13mo
    // ago") is intentional — once the age crosses a year the
    // months count becomes a worse summary than the years count.
    expect(ageBucket(String(NOW - 364 * DAY), NOW)).toEqual({
      kind: "months",
      count: 12,
    });
    expect(ageBucket(String(NOW - 365 * DAY), NOW)).toEqual({
      kind: "years",
      count: 1,
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

    // One second past the cutoff IS eligible. Build inline so the
    // age is obvious top-to-bottom rather than `makeArchived` +
    // override.
    const justOver: Workspace = {
      ...makeArchived("justOver30", 30),
      created_at: String(NOW - 30 * DAY - 1),
    };
    expect(filterByAge([justOver], "30", NOW).map((w) => w.id)).toEqual([
      "justOver30",
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

describe("groupByRepository", () => {
  function makeRepo(id: string, name: string): Repository {
    return {
      id,
      path: `/tmp/${id}`,
      name,
      path_slug: id,
      icon: null,
      created_at: "0",
      setup_script: null,
      custom_instructions: null,
      sort_order: 0,
      branch_rename_preferences: null,
      setup_script_auto_run: false,
      archive_script: null,
      archive_script_auto_run: false,
      base_branch: null,
      default_remote: null,
      path_valid: true,
      remote_connection_id: null,
    };
  }

  function makeWs(id: string, repoId: string): Workspace {
    return {
      ...makeArchived(id, 0),
      repository_id: repoId,
    };
  }

  it("returns groups in `repositories` order, not workspace order", () => {
    const repos = [makeRepo("r1", "first"), makeRepo("r2", "second")];
    const ws = [makeWs("w1", "r2"), makeWs("w2", "r1"), makeWs("w3", "r2")];
    const out = groupByRepository(ws, repos);
    expect(out.map((g) => g.repo.id)).toEqual(["r1", "r2"]);
    expect(out[0].workspaces.map((w) => w.id)).toEqual(["w2"]);
    expect(out[1].workspaces.map((w) => w.id)).toEqual(["w1", "w3"]);
  });

  it("preserves input workspace order within each group", () => {
    const repos = [makeRepo("r1", "first")];
    const ws = [makeWs("c", "r1"), makeWs("a", "r1"), makeWs("b", "r1")];
    const out = groupByRepository(ws, repos);
    expect(out[0].workspaces.map((w) => w.id)).toEqual(["c", "a", "b"]);
  });

  it("omits repos with no workspaces", () => {
    const repos = [makeRepo("r1", "has"), makeRepo("r2", "empty")];
    const ws = [makeWs("w1", "r1")];
    expect(groupByRepository(ws, repos).map((g) => g.repo.id)).toEqual(["r1"]);
  });

  it("drops workspaces whose repository_id is not in `repositories`", () => {
    const repos = [makeRepo("r1", "known")];
    const ws = [makeWs("w1", "r1"), makeWs("w2", "r-missing")];
    const out = groupByRepository(ws, repos);
    expect(out).toHaveLength(1);
    expect(out[0].workspaces.map((w) => w.id)).toEqual(["w1"]);
  });
});
