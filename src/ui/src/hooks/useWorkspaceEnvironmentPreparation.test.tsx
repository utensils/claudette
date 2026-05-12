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
      activeModal: null,
      modalData: {},
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

  it("opens the trust modal from the prepare response even if the event was missed", async () => {
    serviceMocks.prepareWorkspaceEnvironment.mockResolvedValue({
      workspace_id: "ws-1",
      repo_id: "repo-1",
      plugins: [
        {
          plugin_name: "env-direnv",
          message: ".envrc is blocked.",
          config_path: "/tmp/feature/.envrc",
          error_excerpt: "direnv: error /tmp/feature/.envrc is blocked",
        },
      ],
    });
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppStore.getState().activeModal).toBe("envTrust");
    expect(useAppStore.getState().modalData).toMatchObject({
      workspace_id: "ws-1",
      repo_id: "repo-1",
      plugins: [{ plugin_name: "env-direnv" }],
    });
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "ready",
    });
  });

  it("does not reopen the same trust modal after Decide later and workspace reselection", async () => {
    const payload = {
      workspace_id: "ws-1",
      repo_id: "repo-1",
      plugins: [
        {
          plugin_name: "env-direnv",
          message: ".envrc is blocked.",
          config_path: "/tmp/feature/.envrc",
          error_excerpt: "direnv: error /tmp/feature/.envrc is blocked",
        },
      ],
    };
    serviceMocks.prepareWorkspaceEnvironment.mockResolvedValue(payload);
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAppStore.getState().activeModal).toBe("envTrust");

    act(() => {
      useAppStore.getState().closeModal();
      useAppStore.setState({ selectedWorkspaceId: null });
    });
    expect(useAppStore.getState().activeModal).toBeNull();

    act(() => {
      useAppStore.setState({ selectedWorkspaceId: "ws-1" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(serviceMocks.prepareWorkspaceEnvironment).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().activeModal).toBeNull();
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

  it("leaves status at 'preparing' when selection changes mid-flight; cancelled guard prevents stale resolution from toasting", async () => {
    // Previously this test pinned cleanup-sets-idle behavior. That
    // behaviour was the source of a Windows-specific UI lock: when
    // WebView2 dropped the Tauri response message for the prep
    // command, the second mount's `cancelled` guard swallowed any
    // late resolution, and status stayed at "idle" / "preparing"
    // forever with no path back to "ready". The cleanup no longer
    // mutates status, and the `cancelled` flag is retained only to
    // suppress stale toasts from `.catch`. The actual recovery for
    // a dropped Tauri response lives in the Complete progress event
    // — see the "recovers from a dropped Tauri response" test below.
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

    // Cleanup ran but does NOT touch status — the in-flight prep
    // promise is still pending. The user-visible recovery for a
    // mid-flight navigate-away lives in the Complete progress
    // event (Rust-side Drop fires it regardless of where the
    // resolve was initiated), not in this hook's cleanup.
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "preparing",
    });

    await act(async () => {
      resolvePreparation();
      await Promise.resolve();
    });

    // The `.then` checks `cancelled` (set true by cleanup) and
    // returns early — status is NOT silently flipped to "ready"
    // for a workspace whose effect has torn down. The Complete
    // progress event remains the lifecycle-independent recovery
    // path for any workspace genuinely stuck at "preparing".
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "preparing",
    });
  });

  /**
   * Build a fresh listen-callback capture and a thin emitter helper.
   * The harness mocks `@tauri-apps/api/event::listen` to a no-op, so
   * we install our own capture per test to fire synthetic
   * `workspace_env_progress` events into the hook.
   */
  async function withCapturedProgressListener(): Promise<{
    fire: (payload: {
      workspace_id: string;
      plugin: string;
      phase: "started" | "finished" | "complete";
      elapsed_ms: number;
      ok?: boolean;
    }) => void;
  }> {
    const listeners: Array<(event: { payload: unknown }) => void> = [];
    const eventMod = await import("@tauri-apps/api/event");
    vi.mocked(eventMod.listen).mockImplementation((_name, cb) => {
      listeners.push(cb as (event: { payload: unknown }) => void);
      return Promise.resolve(() => undefined);
    });
    return {
      fire: (payload) => {
        act(() => {
          for (const cb of listeners) {
            cb({ payload });
          }
        });
      },
    };
  }

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

    const { fire } = await withCapturedProgressListener();

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
    fire({
      workspace_id: "ws-1",
      plugin: "",
      phase: "complete",
      elapsed_ms: 0,
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "ready",
    });
  });

  it("transitions to 'error' on 'complete' when any plugin reported failure (dropped Err response recovery)", async () => {
    // The Windows IPC-drop variant where the bug bites hardest: the
    // backend prep returned Err (e.g. direnv .envrc blocked), but
    // WebView2 dropped the response so `.catch` never fired. Without
    // failure tracking, the Complete handler would silently mark
    // "ready" — hiding the trust error from the user. With failure
    // tracking, the Complete handler sees that a plugin emitted
    // `finished { ok: false }` during this resolve and transitions
    // to "error" with a synthetic message pointing at the env panel
    // (where the per-plugin error text is surfaced).
    serviceMocks.prepareWorkspaceEnvironment.mockReturnValue(
      new Promise<void>(() => undefined),
    );
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    const { fire } = await withCapturedProgressListener();

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    // Started → Finished with ok=false → Complete. Mirrors what the
    // Rust sink emits when a plugin's detect/export errors and the
    // dispatcher records the failure but the command's Tauri
    // response is dropped en route to the webview.
    fire({
      workspace_id: "ws-1",
      plugin: "env-direnv",
      phase: "started",
      elapsed_ms: 0,
    });
    fire({
      workspace_id: "ws-1",
      plugin: "env-direnv",
      phase: "finished",
      elapsed_ms: 8,
      ok: false,
    });
    fire({
      workspace_id: "ws-1",
      plugin: "",
      phase: "complete",
      elapsed_ms: 0,
    });

    const env = useAppStore.getState().workspaceEnvironment["ws-1"];
    expect(env?.status).toBe("error");
    expect(env?.error).toMatch(/environment provider reported errors/i);
  });

  it("clears per-workspace failure tracking after Complete so a fresh resolve isn't poisoned", async () => {
    // The failure flag is reset on every Complete so a subsequent
    // resolve starts with a clean slate. Without the reset, a
    // workspace that ever saw `ok: false` would stay "stuck error"
    // forever even after the user fixed the underlying issue
    // (e.g. ran `direnv allow`) and the next resolve succeeded.
    serviceMocks.prepareWorkspaceEnvironment.mockReturnValue(
      new Promise<void>(() => undefined),
    );
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    const { fire } = await withCapturedProgressListener();

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    // Resolve #1: a plugin failed.
    fire({
      workspace_id: "ws-1",
      plugin: "env-direnv",
      phase: "started",
      elapsed_ms: 0,
    });
    fire({
      workspace_id: "ws-1",
      plugin: "env-direnv",
      phase: "finished",
      elapsed_ms: 8,
      ok: false,
    });
    fire({
      workspace_id: "ws-1",
      plugin: "",
      phase: "complete",
      elapsed_ms: 0,
    });
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]?.status).toBe(
      "error",
    );

    // Reset to "preparing" so the next Complete has a status to act on
    // (mirroring what a fresh selectWorkspace → prep call would do).
    useAppStore
      .getState()
      .setWorkspaceEnvironment("ws-1", "preparing");

    // Resolve #2: same workspace, this time all plugins succeed.
    // The failure tracking from resolve #1 MUST NOT leak in.
    fire({
      workspace_id: "ws-1",
      plugin: "env-dotenv",
      phase: "started",
      elapsed_ms: 0,
    });
    fire({
      workspace_id: "ws-1",
      plugin: "env-dotenv",
      phase: "finished",
      elapsed_ms: 4,
      ok: true,
    });
    fire({
      workspace_id: "ws-1",
      plugin: "",
      phase: "complete",
      elapsed_ms: 0,
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "ready",
    });
  });

  it("does not regress a ready workspace when a stray 'complete' event arrives", async () => {
    // The Complete event is best-effort — if it arrives for a
    // workspace whose status has already been set to "ready" by a
    // prior `.then`, it MUST NOT silently revert. This pin matters
    // because the Drop-emitted Complete and the Tauri command's own
    // `.then` race naturally; on a healthy IPC channel the `.then`
    // wins, and Complete then arrives as a no-op terminator.
    serviceMocks.prepareWorkspaceEnvironment.mockResolvedValue(undefined);
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    const { fire } = await withCapturedProgressListener();

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    // `.then` ran first → status is ready before Complete arrives.
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "ready",
    });

    fire({
      workspace_id: "ws-1",
      plugin: "",
      phase: "complete",
      elapsed_ms: 0,
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "ready",
    });
  });

  it("does not override an 'error' workspace when 'complete' arrives", async () => {
    // The error case has the same race risk as the ready case: a
    // backend resolve that fails (e.g. direnv blocked) sets status
    // to "error" via the prep `.catch`; the sink's Drop fires
    // Complete immediately after, and that terminator must NOT
    // silently overwrite the error the user needs to see.
    serviceMocks.prepareWorkspaceEnvironment.mockRejectedValue(
      new Error("direnv blocked"),
    );
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [makeWorkspace()],
    });

    const { fire } = await withCapturedProgressListener();

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toMatchObject({
      status: "error",
    });

    fire({
      workspace_id: "ws-1",
      plugin: "",
      phase: "complete",
      elapsed_ms: 0,
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toMatchObject({
      status: "error",
    });
  });

  it("handles a full Started → Finished → Complete sequence from a non-prep path (e.g. spawn_pty)", async () => {
    // The original Windows bug: `spawn_pty` runs its own env resolve
    // that emits Started/Finished progress events (flipping status
    // to "preparing" via `setWorkspaceEnvironmentProgress`), but no
    // dedicated Tauri-command `.then` exists on the JS side to
    // finalize. The Complete event from Drop on the sink is now the
    // authoritative finalizer for these paths; this test exercises
    // the full sequence without the prep hook ever firing.
    useAppStore.setState({
      selectedWorkspaceId: null, // prep effect skipped — no selected workspace
      workspaces: [makeWorkspace()],
      workspaceEnvironment: { "ws-1": { status: "ready" } },
    });

    const { fire } = await withCapturedProgressListener();

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    // Started: status flips to "preparing", current_plugin set.
    fire({
      workspace_id: "ws-1",
      plugin: "env-dotenv",
      phase: "started",
      elapsed_ms: 0,
    });
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toMatchObject({
      status: "preparing",
      current_plugin: "env-dotenv",
    });

    // Finished: current_plugin cleared, status stays "preparing"
    // (more plugins may be coming).
    fire({
      workspace_id: "ws-1",
      plugin: "env-dotenv",
      phase: "finished",
      elapsed_ms: 12,
      ok: true,
    });
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toMatchObject({
      status: "preparing",
    });
    expect(
      useAppStore.getState().workspaceEnvironment["ws-1"]?.current_plugin,
    ).toBeUndefined();

    // Complete: the resolve loop is done. Transition out of
    // progress-induced "preparing" back to "ready".
    fire({
      workspace_id: "ws-1",
      plugin: "",
      phase: "complete",
      elapsed_ms: 0,
    });
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]).toEqual({
      status: "ready",
    });
  });

  it("routes progress for a non-selected workspace and still finalizes via Complete", async () => {
    // The sidebar shows "preparing" badges for every workspace
    // resolving env, not just the selected one. This pin matters
    // because background paths (repo warmup, a different
    // workspace's PTY spawn) emit progress that the listener must
    // route by workspace_id, and Complete must finalize the
    // intended workspace — not silently target the active one.
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      workspaces: [
        makeWorkspace({ id: "ws-1" }),
        makeWorkspace({ id: "ws-2", name: "other" }),
      ],
      workspaceEnvironment: { "ws-1": { status: "ready" } },
    });
    serviceMocks.prepareWorkspaceEnvironment.mockResolvedValue(undefined);

    const { fire } = await withCapturedProgressListener();

    await renderHarness();
    await act(async () => {
      await Promise.resolve();
    });

    fire({
      workspace_id: "ws-2",
      plugin: "env-direnv",
      phase: "started",
      elapsed_ms: 0,
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-2"]).toMatchObject({
      status: "preparing",
      current_plugin: "env-direnv",
    });
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]?.status).toBe(
      "ready",
    );

    fire({
      workspace_id: "ws-2",
      plugin: "",
      phase: "complete",
      elapsed_ms: 0,
    });

    expect(useAppStore.getState().workspaceEnvironment["ws-2"]).toEqual({
      status: "ready",
    });
    // The selected workspace's status is untouched by the other ws's
    // progress stream.
    expect(useAppStore.getState().workspaceEnvironment["ws-1"]?.status).toBe(
      "ready",
    );
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
