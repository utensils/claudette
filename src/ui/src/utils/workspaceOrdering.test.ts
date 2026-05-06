import { describe, expect, it } from "vitest";
import type { ScmSummary } from "../types/plugin";
import type { Workspace } from "../types/workspace";
import {
  orderRepoWorkspaces,
  repoIdFromWorkspaceOrderModeKey,
  WORKSPACE_ORDER_MODE_PREFIX,
} from "./workspaceOrdering";

function workspace(
  id: string,
  sort_order: number,
  created_at: string,
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
    created_at,
    sort_order,
    remote_connection_id: null,
  };
}

function summary(
  prState: ScmSummary["prState"],
  ciState: ScmSummary["ciState"],
  hasPr = true,
): ScmSummary {
  return { hasPr, prState, ciState, lastUpdated: 0 };
}

describe("orderRepoWorkspaces", () => {
  const rows = [
    workspace("created-first-no-pr", 0, "2026-01-01T00:00:00Z"),
    workspace("created-second-passing", 1, "2026-01-02T00:00:00Z"),
    workspace("created-third-draft", 2, "2026-01-03T00:00:00Z"),
  ];

  const scmSummary: Record<string, ScmSummary> = {
    "created-first-no-pr": summary(null, null, false),
    "created-second-passing": summary("open", "success"),
    "created-third-draft": summary("draft", null),
  };

  it("uses the original SCM-priority order until the user manually reorders", () => {
    expect(orderRepoWorkspaces(rows, scmSummary, false).map((w) => w.id)).toEqual([
      "created-second-passing",
      "created-third-draft",
      "created-first-no-pr",
    ]);
  });

  it("uses persisted sort_order after the repo is marked manually ordered", () => {
    const manuallyReordered = [
      { ...rows[0], sort_order: 2 },
      { ...rows[1], sort_order: 1 },
      { ...rows[2], sort_order: 0 },
    ];

    expect(
      orderRepoWorkspaces(manuallyReordered, scmSummary, true).map((w) => w.id),
    ).toEqual([
      "created-third-draft",
      "created-second-passing",
      "created-first-no-pr",
    ]);
  });

  it("keeps creation order as the auto-sort tie-breaker", () => {
    const tied = [
      workspace("created-second", 0, "2026-01-02T00:00:00Z"),
      workspace("created-first", 1, "2026-01-01T00:00:00Z"),
    ];
    const noPr = {
      "created-first": summary(null, null, false),
      "created-second": summary(null, null, false),
    };

    expect(orderRepoWorkspaces(tied, noPr, false).map((w) => w.id)).toEqual([
      "created-first",
      "created-second",
    ]);
  });
});

describe("repoIdFromWorkspaceOrderModeKey", () => {
  it("extracts repo ids from workspace order setting keys", () => {
    expect(
      repoIdFromWorkspaceOrderModeKey(`${WORKSPACE_ORDER_MODE_PREFIX}repo-1`),
    ).toBe("repo-1");
    expect(repoIdFromWorkspaceOrderModeKey("view:sidebar_group_by")).toBeNull();
  });
});
