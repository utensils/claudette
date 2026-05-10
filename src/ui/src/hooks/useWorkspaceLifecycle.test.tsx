// @vitest-environment happy-dom

// Tests for `useWorkspaceLifecycle`. We mock the underlying tauri service
// calls and the global `useAppStore` so the hook can be exercised in pure
// unit form without spinning up the full store machinery — what we really
// want to verify is the *sequencing* of optimistic update → backend call →
// reconcile or rollback, since that's where regressions break user-visible
// behavior (e.g. archive button leaves the user staring at a stale chat
// because we forgot to deselect).
//
// Note on the `act(async () => { result = await fn() })` pattern: we
// capture the hook's return value into an outer `let result` rather than
// relying on `act()`'s return value. React's typed `act` *does* forward
// the callback's resolved value, but doing it this way removes any
// ambiguity (Copilot review on the missing-CLI fix PR flagged the inline
// form as potentially returning `undefined`) and the explicit binding is
// clearer to read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEffect } from "react";

const stateRef = vi.hoisted(() => ({
  state: {
    workspaces: [] as Array<{
      id: string;
      status: string;
      worktree_path: string | null;
      agent_status: string;
    }>,
    selectedWorkspaceId: null as string | null,
  },
  updateWorkspace: vi.fn((id: string, patch: Record<string, unknown>) => {
    const idx = stateRef.state.workspaces.findIndex((w) => w.id === id);
    if (idx >= 0) {
      stateRef.state.workspaces[idx] = {
        ...stateRef.state.workspaces[idx],
        ...patch,
      };
    }
  }),
  removeWorkspace: vi.fn((id: string) => {
    stateRef.state.workspaces = stateRef.state.workspaces.filter((w) => w.id !== id);
  }),
  selectWorkspace: vi.fn((id: string | null) => {
    stateRef.state.selectedWorkspaceId = id;
  }),
}));

vi.mock("../stores/useAppStore", () => ({
  useAppStore: Object.assign(
    <T,>(
      selector: (state: typeof stateRef.state & {
        updateWorkspace: typeof stateRef.updateWorkspace;
        removeWorkspace: typeof stateRef.removeWorkspace;
        selectWorkspace: typeof stateRef.selectWorkspace;
      }) => T,
    ): T =>
      selector({
        ...stateRef.state,
        updateWorkspace: stateRef.updateWorkspace,
        removeWorkspace: stateRef.removeWorkspace,
        selectWorkspace: stateRef.selectWorkspace,
      }),
    {
      getState: () => ({
        ...stateRef.state,
        updateWorkspace: stateRef.updateWorkspace,
        removeWorkspace: stateRef.removeWorkspace,
        selectWorkspace: stateRef.selectWorkspace,
      }),
    },
  ),
}));

const tauriApi = vi.hoisted(() => ({
  archiveWorkspace: vi.fn(async () => false),
  restoreWorkspace: vi.fn(async () => "/restored"),
}));

vi.mock("../services/tauri", () => tauriApi);

import { useWorkspaceLifecycle, type LifecycleResult } from "./useWorkspaceLifecycle";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

interface HookResult {
  archive: ReturnType<typeof useWorkspaceLifecycle>["archive"];
  restore: ReturnType<typeof useWorkspaceLifecycle>["restore"];
}

async function mountHook(): Promise<HookResult> {
  let captured: HookResult | null = null;
  function Probe() {
    const api = useWorkspaceLifecycle();
    useEffect(() => {
      captured = api;
    }, [api]);
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<Probe />);
  });
  if (!captured) throw new Error("hook didn't capture");
  return captured;
}

function seedWorkspace(extras: Partial<typeof stateRef.state.workspaces[number]> = {}) {
  stateRef.state.workspaces = [
    {
      id: "ws-1",
      status: "Active",
      worktree_path: "/tmp/lush-daisy",
      agent_status: "Running",
      ...extras,
    },
  ];
}

describe("useWorkspaceLifecycle.archive", () => {
  beforeEach(() => {
    stateRef.updateWorkspace.mockClear();
    stateRef.removeWorkspace.mockClear();
    stateRef.selectWorkspace.mockClear();
    tauriApi.archiveWorkspace.mockReset().mockResolvedValue(false);
    tauriApi.restoreWorkspace.mockReset().mockResolvedValue("/restored");
    stateRef.state.workspaces = [];
    stateRef.state.selectedWorkspaceId = null;
  });

  afterEach(async () => {
    await act(async () => {
      mountedRoots.forEach((r) => r.unmount());
    });
    mountedContainers.forEach((c) => c.remove());
    mountedRoots.length = 0;
    mountedContainers.length = 0;
  });

  it("optimistically marks the workspace archived and deselects it when it was selected", async () => {
    seedWorkspace();
    stateRef.state.selectedWorkspaceId = "ws-1";
    const { archive } = await mountHook();

    // Capture the hook return via an outer binding rather than relying on
    // `act`'s return value — see the file-header note about Copilot
    // review feedback.
    let result: LifecycleResult | undefined;
    await act(async () => {
      result = await archive("ws-1");
    });

    expect(result).toEqual({ ok: true });
    // Optimistic update first: status flips before the backend call returns.
    expect(stateRef.updateWorkspace).toHaveBeenCalledWith("ws-1", {
      status: "Archived",
      worktree_path: null,
      agent_status: "Stopped",
    });
    // Selection cleared so the chat tab is replaced by the empty state.
    expect(stateRef.selectWorkspace).toHaveBeenCalledWith(null);
    expect(tauriApi.archiveWorkspace).toHaveBeenCalledWith("ws-1", undefined);
  });

  it("does not deselect when the archived workspace was not the selected one", async () => {
    seedWorkspace();
    stateRef.state.selectedWorkspaceId = "ws-other";
    const { archive } = await mountHook();
    await act(async () => archive("ws-1"));
    // Should never call selectWorkspace at all on this path.
    expect(stateRef.selectWorkspace).not.toHaveBeenCalled();
  });

  it("removes the workspace when the backend reports a hard delete", async () => {
    seedWorkspace();
    tauriApi.archiveWorkspace.mockResolvedValueOnce(true);
    const { archive } = await mountHook();
    await act(async () => archive("ws-1"));
    expect(stateRef.removeWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("rolls back optimistic state and restores selection on backend failure", async () => {
    seedWorkspace();
    stateRef.state.selectedWorkspaceId = "ws-1";
    const fail = new Error("boom");
    tauriApi.archiveWorkspace.mockRejectedValueOnce(fail);
    const { archive } = await mountHook();
    let result: LifecycleResult | undefined;
    await act(async () => {
      result = await archive("ws-1");
    });
    expect(result).toEqual({ ok: false, error: fail });
    // Last updateWorkspace call should be the rollback to the snapshot.
    const updateCalls = stateRef.updateWorkspace.mock.calls;
    expect(updateCalls.at(-1)?.[0]).toBe("ws-1");
    expect(updateCalls.at(-1)?.[1]).toMatchObject({
      status: "Active",
      worktree_path: "/tmp/lush-daisy",
      agent_status: "Running",
    });
    // Selection restored because the user didn't navigate elsewhere.
    expect(stateRef.selectWorkspace).toHaveBeenLastCalledWith("ws-1");
  });

  it("does not restore selection if the user moved to another workspace mid-flight", async () => {
    seedWorkspace();
    stateRef.state.selectedWorkspaceId = "ws-1";
    let resolveArchive: ((v: boolean) => void) | null = null;
    tauriApi.archiveWorkspace.mockImplementationOnce(
      () =>
        new Promise<boolean>((_, reject) => {
          resolveArchive = (() => reject(new Error("nope"))) as unknown as (v: boolean) => void;
        }),
    );
    const { archive } = await mountHook();
    let archivePromise: Promise<unknown> | null = null;
    await act(async () => {
      archivePromise = archive("ws-1");
    });
    // Simulate the user switching to another workspace while archive is in flight.
    stateRef.state.selectedWorkspaceId = "ws-2";
    await act(async () => {
      resolveArchive?.(false);
      await archivePromise;
    });
    // Selection should NOT be restored back to ws-1 — the user is on ws-2 now.
    const selectCalls = stateRef.selectWorkspace.mock.calls;
    const finalCall = selectCalls.at(-1);
    expect(finalCall?.[0]).toBe(null);
  });

  it("forwards skipScript option to the backend", async () => {
    seedWorkspace();
    const { archive } = await mountHook();
    await act(async () => archive("ws-1", { skipScript: true }));
    expect(tauriApi.archiveWorkspace).toHaveBeenCalledWith("ws-1", true);
  });
});

describe("useWorkspaceLifecycle.restore", () => {
  beforeEach(() => {
    stateRef.updateWorkspace.mockClear();
    tauriApi.restoreWorkspace.mockReset().mockResolvedValue("/restored");
    stateRef.state.workspaces = [];
  });

  afterEach(async () => {
    await act(async () => {
      mountedRoots.forEach((r) => r.unmount());
    });
    mountedContainers.forEach((c) => c.remove());
    mountedRoots.length = 0;
    mountedContainers.length = 0;
  });

  it("flips workspace back to Active with the path returned by the backend", async () => {
    seedWorkspace({ status: "Archived", worktree_path: null });
    tauriApi.restoreWorkspace.mockResolvedValueOnce("/abs/restored/lush-daisy");
    const { restore } = await mountHook();
    let result: LifecycleResult | undefined;
    await act(async () => {
      result = await restore("ws-1");
    });
    expect(result).toEqual({ ok: true });
    expect(stateRef.updateWorkspace).toHaveBeenCalledWith("ws-1", {
      status: "Active",
      worktree_path: "/abs/restored/lush-daisy",
    });
  });

  it("returns an error result without mutating state when the backend fails", async () => {
    seedWorkspace({ status: "Archived", worktree_path: null });
    const fail = new Error("worktree add failed");
    tauriApi.restoreWorkspace.mockRejectedValueOnce(fail);
    const { restore } = await mountHook();
    let result: LifecycleResult | undefined;
    await act(async () => {
      result = await restore("ws-1");
    });
    expect(result).toEqual({ ok: false, error: fail });
    expect(stateRef.updateWorkspace).not.toHaveBeenCalled();
  });
});
