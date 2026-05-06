import { describe, expect, it } from "vitest";
import { isRemoteCheckpointWorkspace } from "./checkpointWorkspace";
import type { Workspace } from "../types";

function workspace(
  id: string,
  remoteConnectionId: string | null,
): Workspace {
  return {
    id,
    repository_id: "repo-1",
    name: id,
    branch_name: id,
    worktree_path: `/tmp/${id}`,
    created_at: "",
    agent_status: "Idle",
    status: "Active",
    sort_order: 0,
    status_line: "",
    remote_connection_id: remoteConnectionId,
  };
}

describe("isRemoteCheckpointWorkspace", () => {
  it("returns true when a checkpoint event belongs to a remote workspace", () => {
    expect(isRemoteCheckpointWorkspace([
      workspace("local", null),
      workspace("remote", "conn-1"),
    ], "remote")).toBe(true);
  });

  it("returns false for local or unknown workspaces", () => {
    expect(isRemoteCheckpointWorkspace([workspace("local", null)], "local")).toBe(false);
    expect(isRemoteCheckpointWorkspace([workspace("local", null)], "missing")).toBe(false);
  });
});
