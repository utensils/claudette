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

  it("leaves status at 'preparing' when selection changes mid-flight; per-closure settled prevents stale resolution from updating state", async () => {
    // Previously this test pinned cleanup-sets-idle behavior. That
    // behavior was the source of a Windows-specific UI lock: when
    // WebView2 dropped the Tauri response message, the second
    // mount's `cancelled` guard swallowed any late resolution, and
    // status stayed at "idle" / "preparing" forever with no path
    // back to "ready". The cleanup no longer mutates status; a
    // per-closure `settled` flag (and a 30s deadline, exercised in a
    // separate test) provide the recovery guarantee instead.
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

    // Cleanup ran but does NOT touch status — the in-flight prep is
    // either going to resolve (and settle for the live closure, which
    // is now marked settled, so its .then is a no-op) or will time
    // out on its own deadline. Leaving status as "preparing" here
    // means a user who returns to this workspace before the deadline
    // sees the actual in-flight state rather than a synthetic "idle".
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "preparing",
    });

    await act(async () => {
      resolvePreparation();
      await Promise.resolve();
    });

    // The closure's `settled` was set to true by the cleanup, so
    // this late resolution is correctly ignored — no transition to
    // "ready" for a workspace the user has navigated away from.
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "preparing",
    });
  });

  it("recovers from a dropped Tauri response when a 'complete' progress event arrives", async () => {
    // The Windows regression we're guarding against: WebView2
    // occasionally drops the response message for a short Tauri
    // async command, so the JS-side `invoke()` promise from
    // `prepareWorkspaceEnvironment` never settles. The backend has
    // long since finished, though — Drop on `TauriEnvProgressSink`
    // emits a `complete` progress event as the resolve loop tears
    // down. This test mimics that event and pins the recovery: any
    // workspace still showing `"preparing"` flips to `"ready"`.
    serviceMocks.prepareWorkspaceEnvironment.mockReturnValue(
      new Promise<void>(() => undefined),
    );
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    // Capture the listen callback so we can fire it manually below —
    // the test harness mocks `@tauri-apps/api/event::listen` to a
    // no-op, so we have to install our own handler this way.
    const eventListeners: Array<(event: { payload: unknown }) => void> = [];
    const eventMod = await import("@tauri-apps/api/event");
    vi.mocked(eventMod.listen).mockImplementation((_name, cb) => {
      eventListeners.push(cb as (event: { payload: unknown }) => void);
      return Promise.resolve(() => undefined);
    });

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "preparing",
    });

    // Fire the `complete` event the Rust-side sink would emit at the
    // end of every resolve, regardless of which Tauri command
    // initiated it.
    act(() => {
      for (const cb of eventListeners) {
        cb({
          payload: {
            workspace_id: "ws-1",
            plugin: "",
            phase: "complete",
            elapsed_ms: 0,
          },
        });
      }
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "ready",
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
