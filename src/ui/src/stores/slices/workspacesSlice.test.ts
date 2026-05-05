import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../useAppStore";
import type { Workspace } from "../../types/workspace";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    repository_id: "repo-1",
    name: "feature",
    branch_name: "james/feature",
    worktree_path: "/tmp/feature",
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "1700000000",
    remote_connection_id: null,
    ...overrides,
  };
}

describe("workspacesSlice.addWorkspace", () => {
  beforeEach(() => {
    useAppStore.setState({ workspaces: [], selectedWorkspaceId: null });
  });

  it("appends a workspace when the id is new", () => {
    const ws = makeWorkspace();
    useAppStore.getState().addWorkspace(ws);
    const result = useAppStore.getState().workspaces;
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ws-1");
  });

  // Regression: a workspace create dispatched from the GUI's own
  // create_workspace command races with the `workspaces-changed` IPC
  // event TauriHooks emits. Whichever fires first calls addWorkspace,
  // and the other arrives moments later with the same id. Without a
  // dedup the sidebar shows two identical rows for one workspace.
  it("does not duplicate when the same id is added twice (race regression)", () => {
    const ws = makeWorkspace();
    useAppStore.getState().addWorkspace(ws);
    useAppStore.getState().addWorkspace(ws);
    const result = useAppStore.getState().workspaces;
    expect(result).toHaveLength(1);
  });

  it("merges fresh fields into the existing row when re-added", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ status_line: "old" }));
    useAppStore
      .getState()
      .addWorkspace(makeWorkspace({ status_line: "new", agent_status: "Running" }));
    const result = useAppStore.getState().workspaces;
    expect(result).toHaveLength(1);
    expect(result[0].status_line).toBe("new");
    expect(result[0].agent_status).toBe("Running");
  });

  it("appends additional workspaces with different ids without disturbing prior rows", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-1" }));
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-2", name: "other" }));
    const result = useAppStore.getState().workspaces;
    expect(result.map((w) => w.id)).toEqual(["ws-1", "ws-2"]);
  });
});
