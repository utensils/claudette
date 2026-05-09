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
    sort_order: 0,
    remote_connection_id: null,
    ...overrides,
  };
}

describe("workspacesSlice.addWorkspace", () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [],
      selectedWorkspaceId: null,
      workspaceEnvironment: {},
    });
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

  it("merges fresh fields (other than agent_status) into the existing row when re-added", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ status_line: "old" }));
    useAppStore
      .getState()
      .addWorkspace(makeWorkspace({ status_line: "new" }));
    const result = useAppStore.getState().workspaces;
    expect(result).toHaveLength(1);
    expect(result[0].status_line).toBe("new");
  });

  // Regression: `agent_status` isn't a DB column — `db::list_workspaces`
  // synthesizes "Idle" on every read. The authoritative value is the
  // one already in the store, set by useAgentStream / ChatPanel from
  // live agent events. A `workspaces-changed` event firing mid-turn
  // (e.g. a sibling workspace's lifecycle transition) was overwriting
  // the live "Running" with the synthetic "Idle", leaving the sidebar
  // showing inactive for workspaces with actively-running agents.
  it("preserves live agent_status on merge (synthetic incoming Idle does not clobber Running)", () => {
    useAppStore
      .getState()
      .addWorkspace(makeWorkspace({ agent_status: "Running" }));
    useAppStore
      .getState()
      .addWorkspace(makeWorkspace({ status_line: "fresh", agent_status: "Idle" }));
    const result = useAppStore.getState().workspaces;
    expect(result).toHaveLength(1);
    expect(result[0].agent_status).toBe("Running");
    // Other fields still merge — only agent_status is preserved.
    expect(result[0].status_line).toBe("fresh");
  });

  // updateWorkspace remains the explicit setter for legitimate
  // transitions like archive → Stopped, so callers that DO know the
  // real value can still write it without bypassing the slice.
  it("updateWorkspace can still set agent_status explicitly", () => {
    useAppStore
      .getState()
      .addWorkspace(makeWorkspace({ agent_status: "Running" }));
    useAppStore.getState().updateWorkspace("ws-1", { agent_status: "Stopped" });
    expect(useAppStore.getState().workspaces[0].agent_status).toBe("Stopped");
  });

  // Regression: a CLI/IPC-driven archive emits `workspaces-changed` with
  // status: Archived AND agent_status: Stopped (the archive really does
  // kill the agent). The blanket "preserve agent_status" rule above was
  // suppressing that legitimate transition, leaving the sidebar showing
  // the archived row as still busy. Status transitions ARE authoritative
  // for agent_status; same-status updates are not.
  it("lets a status transition (Active→Archived) overwrite agent_status with the incoming Stopped", () => {
    useAppStore
      .getState()
      .addWorkspace(makeWorkspace({ status: "Active", agent_status: "Running" }));
    useAppStore.getState().addWorkspace(
      makeWorkspace({ status: "Archived", agent_status: "Stopped" }),
    );
    const result = useAppStore.getState().workspaces;
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("Archived");
    expect(result[0].agent_status).toBe("Stopped");
  });

  // The inverse — restoring an archived row should let the incoming
  // synthetic Idle land, otherwise the sidebar would show the restored
  // row as still Stopped until the next agent stream event.
  it("lets a status transition (Archived→Active) overwrite agent_status with the incoming Idle", () => {
    useAppStore
      .getState()
      .addWorkspace(makeWorkspace({ status: "Archived", agent_status: "Stopped" }));
    useAppStore
      .getState()
      .addWorkspace(makeWorkspace({ status: "Active", agent_status: "Idle" }));
    const result = useAppStore.getState().workspaces;
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("Active");
    expect(result[0].agent_status).toBe("Idle");
  });

  it("appends additional workspaces with different ids without disturbing prior rows", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-1" }));
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-2", name: "other" }));
    const result = useAppStore.getState().workspaces;
    expect(result.map((w) => w.id)).toEqual(["ws-1", "ws-2"]);
  });

  it("tracks workspace environment preparation status", () => {
    useAppStore.getState().setWorkspaceEnvironment("ws-1", "preparing");
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "preparing",
    });

    useAppStore
      .getState()
      .setWorkspaceEnvironment("ws-1", "error", "direnv failed");
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "error",
      error: "direnv failed",
    });
  });

  it("marks a local workspace as preparing as soon as it is selected", () => {
    useAppStore.getState().addWorkspace(makeWorkspace());

    useAppStore.getState().selectWorkspace("ws-1");

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "preparing",
    });
  });

  it("marks a remote workspace ready as soon as it is selected", () => {
    useAppStore.getState().addWorkspace(
      makeWorkspace({ id: "ws-remote", remote_connection_id: "remote-1" }),
    );

    useAppStore.getState().selectWorkspace("ws-remote");

    expect(useAppStore.getState().workspaceEnvironment["ws-remote"]).toEqual({
      status: "ready",
    });
  });
});
