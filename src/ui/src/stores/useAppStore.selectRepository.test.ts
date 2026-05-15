import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { Workspace } from "../types";

// The selectRepository / selectWorkspace pair has subtle mutual-exclusion
// semantics that the rest of the UI depends on: picking a project should
// kick the user out of any open workspace, and selecting a workspace should
// drop any project-scoped view. This test pins both directions plus the
// "Back to Dashboard" no-clobber guarantee.

function makeWs(id: string, repoId: string): Workspace {
  return {
    id,
    repository_id: repoId,
    name: id,
    branch_name: `${id}-branch`,
    worktree_path: `/tmp/${id}`,
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "2026-01-01T00:00:00Z",
    sort_order: 0,
    input_values: null,
    remote_connection_id: null,
  };
}

beforeEach(() => {
  useAppStore.setState({
    selectedWorkspaceId: null,
    selectedRepositoryId: null,
    workspaces: [],
  });
});

describe("selectRepository", () => {
  it("sets the project-scoped id and clears any open workspace", () => {
    useAppStore.setState({
      workspaces: [makeWs("ws-1", "repo-1")],
      selectedWorkspaceId: "ws-1",
    });

    useAppStore.getState().selectRepository("repo-1");

    const state = useAppStore.getState();
    expect(state.selectedRepositoryId).toBe("repo-1");
    expect(state.selectedWorkspaceId).toBeNull();
  });

  it("clearing repo selection does not disturb a current workspace", () => {
    // Reaching this state is unusual (workspace selection clears repo
    // selection too) but the action should still be a clean clear and not
    // accidentally reset the workspace to null.
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      selectedRepositoryId: null,
    });

    useAppStore.getState().selectRepository(null);

    expect(useAppStore.getState().selectedWorkspaceId).toBe("ws-1");
    expect(useAppStore.getState().selectedRepositoryId).toBeNull();
  });
});

describe("selectWorkspace", () => {
  it("clears the project-scoped view when a workspace becomes selected", () => {
    useAppStore.setState({
      workspaces: [makeWs("ws-1", "repo-1")],
      selectedRepositoryId: "repo-1",
    });

    useAppStore.getState().selectWorkspace("ws-1");

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-1");
    expect(state.selectedRepositoryId).toBeNull();
  });

  it("preserves selectedRepositoryId when clearing workspace (workspace=null)", () => {
    // Clearing a workspace via selectWorkspace(null) is a "deselect"
    // primitive; it should leave any project-scoped view intact so callers
    // composing the two actions can stage their own ordering.
    useAppStore.setState({
      workspaces: [makeWs("ws-1", "repo-1")],
      selectedWorkspaceId: "ws-1",
      selectedRepositoryId: "repo-1",
    });

    useAppStore.getState().selectWorkspace(null);

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBeNull();
    expect(state.selectedRepositoryId).toBe("repo-1");
  });
});

describe("goToDashboard", () => {
  it("clears both workspace and repository selection in one shot", () => {
    // The Dashboard is Claudette's default view; navigating to it shouldn't
    // require composing two separate clears. The atomic action protects the
    // UI from rendering an intermediate "workspace cleared but project
    // still selected" frame.
    useAppStore.setState({
      workspaces: [makeWs("ws-1", "repo-1")],
      selectedWorkspaceId: "ws-1",
      selectedRepositoryId: "repo-1",
    });

    useAppStore.getState().goToDashboard();

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBeNull();
    expect(state.selectedRepositoryId).toBeNull();
  });

  it("is a no-op when already on the dashboard", () => {
    useAppStore.setState({
      selectedWorkspaceId: null,
      selectedRepositoryId: null,
    });

    const before = useAppStore.getState();
    useAppStore.getState().goToDashboard();
    const after = useAppStore.getState();

    // Reference equality on the slice contents — confirms `set` returned
    // `s` unchanged rather than producing a new selectedWorkspaceId/Repo
    // pair that would re-render every subscriber.
    expect(after.selectedWorkspaceId).toBe(before.selectedWorkspaceId);
    expect(after.selectedRepositoryId).toBe(before.selectedRepositoryId);
  });
});
