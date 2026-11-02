import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { Workspace } from "../types/workspace";
import type { Repository } from "../types/repository";

function makeWorkspace(id: string, repoId: string, conn: string | null): Workspace {
  return {
    id,
    repository_id: repoId,
    name: `ws-${id}`,
    branch_name: `branch-${id}`,
    worktree_path: null,
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "2026-01-01T00:00:00Z",
    sort_order: 0,
    input_values: null,
    remote_connection_id: conn,
  };
}

function makeRepository(id: string, conn: string | null): Repository {
  return {
    id,
    path: `/repo-${id}`,
    name: `repo-${id}`,
    path_slug: `repo-${id}`,
    icon: null,
    created_at: "2026-01-01T00:00:00Z",
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
    required_inputs: null,
    remote_connection_id: conn,
  };
}

describe("replaceLocalData", () => {
  beforeEach(() => {
    // A paired server's rows adopted before the local initial load landed.
    useAppStore.setState({
      repositories: [makeRepository("stale-local", null), makeRepository("remote-repo", "c1")],
      workspaces: [makeWorkspace("stale-ws", "stale-local", null), makeWorkspace("remote-ws", "remote-repo", "c1")],
      defaultBranches: { "stale-local": "old", "remote-repo": "trunk" },
    });
  });

  it("replaces local rows and keeps the paired servers' rows", () => {
    useAppStore.getState().replaceLocalData({
      repositories: [makeRepository("local-repo", null)],
      workspaces: [makeWorkspace("local-ws", "local-repo", null)],
      defaultBranches: { "local-repo": "main" },
    });
    const s = useAppStore.getState();
    expect(s.repositories.map((r) => r.id)).toEqual(["local-repo", "remote-repo"]);
    expect(s.workspaces.map((w) => w.id)).toEqual(["local-ws", "remote-ws"]);
    expect(s.defaultBranches).toEqual({ "local-repo": "main", "remote-repo": "trunk" });
  });
});
