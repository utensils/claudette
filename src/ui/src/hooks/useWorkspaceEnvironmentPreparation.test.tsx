// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../types/workspace";
import { useAppStore } from "../stores/useAppStore";

const serviceMocks = vi.hoisted(() => ({
  prepareWorkspaceEnvironment: vi.fn(),
}));

vi.mock("../services/tauri", () => serviceMocks);

// The hook subscribes to `workspace_env_progress` Tauri events at
// mount; in vitest there's no Tauri runtime so `listen` would crash
// trying to call into the IPC bridge. Stub it with a no-op that
// resolves to a no-op cleanup function so the effect can run.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import { useWorkspaceEnvironmentPreparation } from "./useWorkspaceEnvironmentPreparation";

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

function Harness() {
  useWorkspaceEnvironmentPreparation();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderHarness() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
  });
}

describe("useWorkspaceEnvironmentPreparation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    serviceMocks.prepareWorkspaceEnvironment.mockReset();
    serviceMocks.prepareWorkspaceEnvironment.mockResolvedValue(undefined);
    useAppStore.setState({
      selectedWorkspaceId: null,
      workspaces: [],
      workspaceEnvironment: {},
      toasts: [],
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("prepares env providers when an existing local workspace is selected", async () => {
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    expect(serviceMocks.prepareWorkspaceEnvironment).toHaveBeenCalledWith("ws-1");
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "ready",
    });
  });

  it("does not run local env providers for remote workspaces", async () => {
    useAppStore.setState({
      selectedWorkspaceId: "ws-remote",
      workspaces: [
        makeWorkspace({
          id: "ws-remote",
          remote_connection_id: "remote-1",
        }),
      ],
    });

    await renderHarness();

    expect(serviceMocks.prepareWorkspaceEnvironment).not.toHaveBeenCalled();
    expect(useAppStore.getState().workspaceEnvironment["ws-remote"]).toEqual({
      status: "ready",
    });
  });

  it("does not restart env preparation when unrelated workspace fields update", async () => {
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      useAppStore
        .getState()
        .updateWorkspace("ws-1", { status_line: "agent is still running" });
    });

    expect(serviceMocks.prepareWorkspaceEnvironment).toHaveBeenCalledTimes(1);
  });

  it("clears stale preparing state when selection changes before preparation finishes", async () => {
    let resolvePreparation!: () => void;
    serviceMocks.prepareWorkspaceEnvironment.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePreparation = resolve;
      }),
    );
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    await renderHarness();
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "preparing",
    });

    act(() => {
      useAppStore.setState({ selectedWorkspaceId: null });
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "idle",
    });

    await act(async () => {
      resolvePreparation();
      await Promise.resolve();
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "idle",
    });
  });

  it("marks the workspace as errored when env preparation fails", async () => {
    serviceMocks.prepareWorkspaceEnvironment.mockRejectedValue(
      new Error("direnv blocked"),
    );
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "error",
      error: "Error: direnv blocked",
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "Workspace environment failed: Error: direnv blocked",
    );
  });
});
