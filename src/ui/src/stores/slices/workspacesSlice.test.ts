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

describe("workspacesSlice pendingFork lifecycle", () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [],
      selectedWorkspaceId: null,
      workspaceEnvironment: {},
      pendingForks: {},
    });
  });

  // The optimistic fork flow: ChatPanel inserts a placeholder workspace
  // and selects it BEFORE awaiting the backend, so the user lands on
  // a "Preparing fork from <source>…" placard the instant they click
  // Fork. `beginPendingFork` is the entry point — it must be atomic
  // (placeholder row, selection, pendingForks entry, and the seeded
  // env-prep `preparing` status with a `started_at` all in one set()),
  // otherwise the sidebar's icon cascade renders a flicker.
  it("seeds placeholder workspace, selection, pendingForks entry, and env-prep status atomically", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-source" }));
    useAppStore.getState().selectWorkspace("ws-source");

    const placeholder: Workspace = makeWorkspace({
      id: "pending-fork-abc",
      name: "feature-fork",
      worktree_path: null,
    });
    useAppStore.getState().beginPendingFork(placeholder, "ws-source");

    const state = useAppStore.getState();
    expect(state.workspaces.map((w) => w.id)).toContain("pending-fork-abc");
    expect(state.selectedWorkspaceId).toBe("pending-fork-abc");
    expect(state.pendingForks["pending-fork-abc"]).toBe("ws-source");
    const env = state.workspaceEnvironment["pending-fork-abc"];
    expect(env?.status).toBe("preparing");
    expect(env?.started_at).toBeTypeOf("number");
  });

  // `commitPendingFork` is the success path: drop the placeholder, add
  // the real workspace (with its real id), move selection from
  // placeholder → real. If the user navigated away mid-fork, selection
  // stays where they put it.
  it("swaps placeholder for real workspace and moves selection on commit", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-source" }));
    useAppStore.getState().selectWorkspace("ws-source");
    useAppStore.getState().beginPendingFork(
      makeWorkspace({ id: "pending-fork-abc", worktree_path: null }),
      "ws-source",
    );

    const real = makeWorkspace({ id: "ws-fork-real", name: "feature-fork" });
    useAppStore.getState().commitPendingFork("pending-fork-abc", real);

    const state = useAppStore.getState();
    expect(state.workspaces.map((w) => w.id)).not.toContain("pending-fork-abc");
    expect(state.workspaces.map((w) => w.id)).toContain("ws-fork-real");
    expect(state.selectedWorkspaceId).toBe("ws-fork-real");
    expect(state.pendingForks["pending-fork-abc"]).toBeUndefined();
    // Placeholder's seeded preparing entry was cleared; the real
    // workspace's prep entry is whatever the env-prep hook will set
    // next (untouched by commit).
    expect(state.workspaceEnvironment["pending-fork-abc"]).toBeUndefined();
  });

  // Regression: the backend emits `workspaces-changed` for the new
  // fork before its IPC response returns. App.tsx's listener calls
  // `addWorkspace(real)` ahead of `commitPendingFork`, so by the time
  // commit runs, the real row is already in the store. A naive
  // `.concat(real)` in commit would double-add it — visible to the
  // user as two identical sidebar rows for one fork.
  it("dedupes the real workspace when commit lands after workspaces-changed listener already added it", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-source" }));
    useAppStore.getState().selectWorkspace("ws-source");
    useAppStore.getState().beginPendingFork(
      makeWorkspace({ id: "pending-fork-abc", worktree_path: null }),
      "ws-source",
    );

    const real = makeWorkspace({ id: "ws-fork-real", name: "feature-fork" });
    // Simulate the `workspaces-changed` listener firing first.
    useAppStore.getState().addWorkspace(real);
    // Then handleFork's await resolves and commit runs.
    useAppStore.getState().commitPendingFork("pending-fork-abc", real);

    const ids = useAppStore.getState().workspaces.map((w) => w.id);
    expect(ids).not.toContain("pending-fork-abc");
    // Real workspace appears exactly once, not twice.
    expect(ids.filter((id) => id === "ws-fork-real")).toHaveLength(1);
  });

  it("leaves selection alone when commit lands after the user navigated away", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-source" }));
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-other" }));
    useAppStore.getState().selectWorkspace("ws-source");
    useAppStore.getState().beginPendingFork(
      makeWorkspace({ id: "pending-fork-abc", worktree_path: null }),
      "ws-source",
    );
    // User navigates away from the placeholder mid-fork.
    useAppStore.getState().selectWorkspace("ws-other");

    useAppStore.getState().commitPendingFork(
      "pending-fork-abc",
      makeWorkspace({ id: "ws-fork-real" }),
    );

    expect(useAppStore.getState().selectedWorkspaceId).toBe("ws-other");
    expect(useAppStore.getState().workspaces.map((w) => w.id)).toContain(
      "ws-fork-real",
    );
  });

  // The error path: backend rejected the fork. Drop the placeholder
  // and restore the source selection so the user lands back where
  // they were before clicking Fork (i.e. on the same row that hosts
  // the same checkpoint list — they can retry without re-navigating).
  it("tears down placeholder and restores selection on cancel", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-source" }));
    useAppStore.getState().selectWorkspace("ws-source");
    useAppStore.getState().beginPendingFork(
      makeWorkspace({ id: "pending-fork-abc", worktree_path: null }),
      "ws-source",
    );

    useAppStore.getState().cancelPendingFork("pending-fork-abc", "ws-source");

    const state = useAppStore.getState();
    expect(state.workspaces.map((w) => w.id)).not.toContain("pending-fork-abc");
    expect(state.workspaces.map((w) => w.id)).toContain("ws-source");
    expect(state.selectedWorkspaceId).toBe("ws-source");
    expect(state.pendingForks["pending-fork-abc"]).toBeUndefined();
    expect(state.workspaceEnvironment["pending-fork-abc"]).toBeUndefined();
  });
});
