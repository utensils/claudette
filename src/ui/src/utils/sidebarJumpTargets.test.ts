import { describe, expect, it } from "vitest";
import type { ScmSummary } from "../types/plugin";
import type { Workspace } from "../types/workspace";
import {
  bucketForWorkspace,
  computeStatusVisibleWorkspaces,
  STATUS_BUCKET_ORDER,
  statusBucketGroupKey,
} from "./sidebarJumpTargets";

function workspace(
  id: string,
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    repository_id: "repo-1",
    name: id,
    branch_name: id,
    worktree_path: `/tmp/${id}`,
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "2026-01-01T00:00:00Z",
    sort_order: 0,
    remote_connection_id: null,
    ...overrides,
  };
}

function summary(
  prState: ScmSummary["prState"],
  hasPr = true,
): ScmSummary {
  return { hasPr, prState, ciState: null, lastUpdated: 0 };
}

describe("bucketForWorkspace", () => {
  it("classifies archived workspaces first, regardless of PR state", () => {
    const ws = workspace("a", { status: "Archived" });
    const scm = { a: summary("open") };
    expect(bucketForWorkspace(ws, scm)).toBe("archived");
  });

  it("classifies by PR state when present", () => {
    expect(bucketForWorkspace(workspace("a"), { a: summary("merged") })).toBe("merged");
    expect(bucketForWorkspace(workspace("a"), { a: summary("closed") })).toBe("closed");
    expect(bucketForWorkspace(workspace("a"), { a: summary("draft") })).toBe("draft");
    expect(bucketForWorkspace(workspace("a"), { a: summary("open") })).toBe("in-review");
  });

  it("falls back to in-progress when there is no PR", () => {
    expect(bucketForWorkspace(workspace("a"), {})).toBe("in-progress");
    expect(
      bucketForWorkspace(workspace("a"), { a: summary(null, false) }),
    ).toBe("in-progress");
  });
});

describe("computeStatusVisibleWorkspaces", () => {
  // Order in STATUS_BUCKET_ORDER: merged, in-review, draft, in-progress, closed, archived.
  const merged = workspace("m1");
  const inReview1 = workspace("r1");
  const inReview2 = workspace("r2");
  const inProgress = workspace("p1");
  const archived = workspace("a1", { status: "Archived" });

  const scm: Record<string, ScmSummary> = {
    m1: summary("merged"),
    r1: summary("open"),
    r2: summary("open"),
    p1: summary(null, false),
  };

  it("concatenates non-collapsed buckets in STATUS_BUCKET_ORDER", () => {
    const out = computeStatusVisibleWorkspaces(
      [inProgress, inReview1, merged, inReview2, archived],
      scm,
      {},
    );
    // merged → in-review → in-progress → archived (closed and draft empty)
    expect(out.map((w) => w.id)).toEqual(["m1", "r1", "r2", "p1", "a1"]);
  });

  it("skips collapsed buckets entirely so badge numbers stay contiguous", () => {
    const collapsed = { [statusBucketGroupKey("in-review")]: true };
    const out = computeStatusVisibleWorkspaces(
      [merged, inReview1, inReview2, inProgress],
      scm,
      collapsed,
    );
    expect(out.map((w) => w.id)).toEqual(["m1", "p1"]);
  });

  it("empty buckets are simply omitted (no holes in the visible list)", () => {
    const out = computeStatusVisibleWorkspaces([merged, inProgress], scm, {});
    expect(out.map((w) => w.id)).toEqual(["m1", "p1"]);
  });

  it("STATUS_BUCKET_ORDER is the canonical render order", () => {
    expect(STATUS_BUCKET_ORDER).toEqual([
      "merged",
      "in-review",
      "draft",
      "in-progress",
      "closed",
      "archived",
    ]);
  });
});
