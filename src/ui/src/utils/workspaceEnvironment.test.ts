import { describe, it, expect } from "vitest";
import type { AppState } from "../stores/useAppStore";
import type { Workspace } from "../types/workspace";
import type { WorkspaceEnvironmentPreparation } from "../stores/slices/workspacesSlice";
import { isWorkspaceEnvironmentPreparing } from "./workspaceEnvironment";

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

/**
 * Build a synthetic `AppState` shaped just enough for
 * `isWorkspaceEnvironmentPreparing` to read. Cast to `AppState` at the
 * call boundary so the gate sees the same field shape it gets in
 * production. Anything the gate doesn't touch can stay absent.
 */
function makeState(
  workspaces: Workspace[],
  env: Record<string, WorkspaceEnvironmentPreparation>,
): AppState {
  return {
    workspaces,
    workspaceEnvironment: env,
  } as unknown as AppState;
}

describe("isWorkspaceEnvironmentPreparing", () => {
  it("returns false when workspaceId is null", () => {
    const state = makeState([makeWorkspace()], {});
    expect(isWorkspaceEnvironmentPreparing(state, null)).toBe(false);
  });

  it("returns false when the workspace is not in the store", () => {
    const state = makeState([], {
      "ws-1": { status: "preparing" },
    });
    expect(isWorkspaceEnvironmentPreparing(state, "ws-1")).toBe(false);
  });

  it("returns false for remote workspaces even when status is preparing", () => {
    // Env-providers resolve on the remote, not locally, so a local
    // "preparing" entry should never gate the UI for a remote ws.
    const state = makeState(
      [makeWorkspace({ id: "ws-1", remote_connection_id: "remote-1" })],
      { "ws-1": { status: "preparing" } },
    );
    expect(isWorkspaceEnvironmentPreparing(state, "ws-1")).toBe(false);
  });

  it("returns true only when status is 'preparing'", () => {
    const state = makeState([makeWorkspace()], {
      "ws-1": { status: "preparing" },
    });
    expect(isWorkspaceEnvironmentPreparing(state, "ws-1")).toBe(true);
  });

  it("returns false for status='ready'", () => {
    const state = makeState([makeWorkspace()], {
      "ws-1": { status: "ready" },
    });
    expect(isWorkspaceEnvironmentPreparing(state, "ws-1")).toBe(false);
  });

  it("returns false for status='error'", () => {
    const state = makeState([makeWorkspace()], {
      "ws-1": { status: "error", error: "direnv blocked" },
    });
    expect(isWorkspaceEnvironmentPreparing(state, "ws-1")).toBe(false);
  });

  it("returns false for status='idle' (regression: was previously true)", () => {
    // Direct pin for the bug we just fixed. The prep hook's cleanup
    // sets a workspace to "idle" when it tears down a stale closure
    // (React StrictMode double-invoke, or a deps-change race during
    // initial workspace load) without a successor re-firing the
    // effect. Treating that stale "idle" as "still preparing" used
    // to permanently lock the terminal new-tab button, the chat
    // composer, and the agent-spawn path with no path back to
    // "ready". Now it just means "no prepare in flight" and the
    // UI is allowed through.
    const state = makeState([makeWorkspace()], {
      "ws-1": { status: "idle" },
    });
    expect(isWorkspaceEnvironmentPreparing(state, "ws-1")).toBe(false);
  });

  it("returns false when the workspace has no entry yet (undefined status)", () => {
    // Pre-hook-fire state — should also not block the UI; the spawn
    // paths resolve env on their own.
    const state = makeState([makeWorkspace()], {});
    expect(isWorkspaceEnvironmentPreparing(state, "ws-1")).toBe(false);
  });
});
