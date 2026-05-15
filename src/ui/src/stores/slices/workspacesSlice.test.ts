import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../useAppStore";
import { findPendingPlaceholderForCreatedWorkspace } from "./workspacesSlice";
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

  // Regression: the source workspace's diff selection / preview state
  // must NOT leak into the placeholder's view. `beginPendingFork`
  // mirrors the diff/preview/right-sidebar-tab resets that
  // `selectWorkspace` performs. Without these resets, the placeholder
  // would render against the source's diffSelectedFile + diffContent
  // + diffMergeBase, which is wrong (no diff exists for the
  // placeholder), and the leaked state would persist back when the
  // real workspace lands or the user cancels.
  it("clears diff/preview state when starting a pending fork (selectWorkspace parity)", () => {
    useAppStore.getState().addWorkspace(makeWorkspace({ id: "ws-source" }));
    useAppStore.getState().selectWorkspace("ws-source");
    // Seed non-null diff/preview state so the assertions below verify
    // the reset path, not just defaults. The exact field shape doesn't
    // matter — beginPendingFork unconditionally writes null. Cast
    // through `Partial<AppState>` so we don't have to construct full
    // FileDiff/FileContent fixtures just to prove they get cleared.
    useAppStore.setState({
      diffSelectedFile: "src/foo.ts",
      diffSelectedLayer: "unstaged",
      diffMergeBase: "abc123",
      diffPreviewLoading: true,
      rightSidebarTab: "changes",
    } as Partial<typeof useAppStore extends { getState: () => infer T } ? T : never>);

    useAppStore.getState().beginPendingFork(
      makeWorkspace({ id: "pending-fork-abc", worktree_path: null }),
      "ws-source",
    );

    const state = useAppStore.getState();
    expect(state.diffSelectedFile).toBeNull();
    expect(state.diffSelectedLayer).toBeNull();
    expect(state.diffContent).toBeNull();
    expect(state.diffMergeBase).toBeNull();
    expect(state.diffPreviewContent).toBeNull();
    expect(state.diffPreviewLoading).toBe(false);
    expect(state.diffPreviewMode).toBe("diff");
    expect(state.rightSidebarTab).toBe("files");
    // The source's diff selection is preserved in the per-workspace
    // map so returning to it (via cancel, or the user navigating back)
    // restores what they were viewing.
    expect(state.diffSelectionByWorkspace["ws-source"]).toEqual({
      path: "src/foo.ts",
      layer: "unstaged",
    });
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

describe("workspacesSlice pendingCreate lifecycle", () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [],
      selectedWorkspaceId: null,
      workspaceEnvironment: {},
      pendingCreates: {},
      diffSelectionByWorkspace: {},
      diffSelectedFile: null,
      diffSelectedLayer: null,
    });
  });

  function makePlaceholder(repoId: string): Workspace {
    return makeWorkspace({
      id: "pending-create-abc",
      repository_id: repoId,
      name: "lemur-snow",
      branch_name: "",
      worktree_path: null,
      sort_order: Number.MAX_SAFE_INTEGER,
    });
  }

  it("beginPendingCreate inserts the placeholder, selects it, and seeds env state to preparing", () => {
    useAppStore.getState().beginPendingCreate(makePlaceholder("repo-1"));
    const state = useAppStore.getState();
    expect(state.workspaces.map((w) => w.id)).toEqual(["pending-create-abc"]);
    expect(state.selectedWorkspaceId).toBe("pending-create-abc");
    expect(state.pendingCreates["pending-create-abc"]).toBe("repo-1");
    const env = state.workspaceEnvironment["pending-create-abc"];
    expect(env?.status).toBe("preparing");
    expect(env?.started_at).toBeTypeOf("number");
  });

  it("commitPendingCreate swaps placeholder for real, migrates env state, moves selection", () => {
    useAppStore.getState().beginPendingCreate(makePlaceholder("repo-1"));
    const real = makeWorkspace({
      id: "ws-real",
      repository_id: "repo-1",
      name: "lemur-snow",
    });
    useAppStore.getState().commitPendingCreate("pending-create-abc", real);
    const state = useAppStore.getState();
    expect(state.workspaces.map((w) => w.id)).toEqual(["ws-real"]);
    expect(state.selectedWorkspaceId).toBe("ws-real");
    expect(state.pendingCreates["pending-create-abc"]).toBeUndefined();
    expect(state.workspaceEnvironment["pending-create-abc"]).toBeUndefined();
    // Placeholder's "preparing" state migrates to the real id so the
    // chat composer / sidebar stay in their loading state until the
    // env-prep hook transitions it to "ready".
    expect(state.workspaceEnvironment["ws-real"]?.status).toBe("preparing");
  });

  it("commitPendingCreate dedupes when workspaces-changed already added the real row", () => {
    // Race: backend emits `workspaces-changed` before the IPC
    // response resolves, so App.tsx's listener inserts the real row
    // first. Commit must not double-add.
    useAppStore.getState().beginPendingCreate(makePlaceholder("repo-1"));
    const real = makeWorkspace({ id: "ws-real", repository_id: "repo-1" });
    useAppStore.getState().addWorkspace(real);
    useAppStore.getState().commitPendingCreate("pending-create-abc", real);
    const ids = useAppStore.getState().workspaces.map((w) => w.id);
    expect(ids).toEqual(["ws-real"]);
  });

  it("commitPendingCreate leaves selection alone if user navigated away mid-create", () => {
    useAppStore.getState().addWorkspace(
      makeWorkspace({ id: "ws-other", repository_id: "repo-2" }),
    );
    useAppStore.getState().beginPendingCreate(makePlaceholder("repo-1"));
    useAppStore.getState().selectWorkspace("ws-other");
    useAppStore.getState().commitPendingCreate(
      "pending-create-abc",
      makeWorkspace({ id: "ws-real" }),
    );
    expect(useAppStore.getState().selectedWorkspaceId).toBe("ws-other");
  });

  it("cancelPendingCreate drops placeholder, env state, and restores selection", () => {
    useAppStore.getState().beginPendingCreate(makePlaceholder("repo-1"));
    useAppStore.getState().cancelPendingCreate("pending-create-abc", null);
    const state = useAppStore.getState();
    expect(state.workspaces).toEqual([]);
    expect(state.selectedWorkspaceId).toBeNull();
    expect(state.pendingCreates["pending-create-abc"]).toBeUndefined();
    expect(state.workspaceEnvironment["pending-create-abc"]).toBeUndefined();
  });
});

describe("findPendingPlaceholderForCreatedWorkspace", () => {
  function placeholder(id: string, repoId: string, name: string): Workspace {
    return makeWorkspace({
      id,
      repository_id: repoId,
      name,
      branch_name: "",
      worktree_path: null,
    });
  }

  it("returns null when no placeholder exists for the repo", () => {
    const match = findPendingPlaceholderForCreatedWorkspace({
      workspaces: [
        placeholder("pending-create-1", "repo-1", "lemur-snow"),
      ],
      pendingCreates: { "pending-create-1": "repo-1" },
      pendingForks: {},
      real: makeWorkspace({ id: "ws-real", repository_id: "repo-2" }),
    });
    expect(match).toBeNull();
  });

  it("matches a pending create by repo + slug", () => {
    const match = findPendingPlaceholderForCreatedWorkspace({
      workspaces: [
        placeholder("pending-create-1", "repo-1", "lemur-snow"),
      ],
      pendingCreates: { "pending-create-1": "repo-1" },
      pendingForks: {},
      real: makeWorkspace({
        id: "ws-real",
        repository_id: "repo-1",
        name: "lemur-snow",
      }),
    });
    expect(match).toEqual({
      placeholderId: "pending-create-1",
      from: "create",
    });
  });

  it("matches a single in-flight fork when allocator added a -N suffix", () => {
    // Fork-of-fork-of-fork: allocator may produce `<source>-fork-2`
    // when `<source>-fork` already exists. The placeholder always uses
    // `<source>-fork`. Allocator-suffix match keeps the swap working.
    const match = findPendingPlaceholderForCreatedWorkspace({
      workspaces: [
        placeholder("pending-fork-1", "repo-1", "main-fork"),
      ],
      pendingCreates: {},
      pendingForks: { "pending-fork-1": "ws-source" },
      real: makeWorkspace({
        id: "ws-real",
        repository_id: "repo-1",
        name: "main-fork-2",
      }),
    });
    expect(match).toEqual({
      placeholderId: "pending-fork-1",
      from: "fork",
    });
  });

  it("refuses the fallback when the real name isn't an allocator-suffix variant of the placeholder", () => {
    // Concurrent CLI / IPC create lands while a placeholder is in
    // flight, same repo, unrelated name. The pre-fix heuristic would
    // swap the placeholder to the unrelated workspace and steal the
    // user's selection. With the allocator-suffix constraint, the
    // real name `c-fork` is not a suffix variant of `main-fork`, so
    // we leave the placeholder alone and let the IPC return commit it.
    const match = findPendingPlaceholderForCreatedWorkspace({
      workspaces: [
        placeholder("pending-fork-1", "repo-1", "main-fork"),
      ],
      pendingCreates: {},
      pendingForks: { "pending-fork-1": "ws-source" },
      real: makeWorkspace({
        id: "ws-real",
        repository_id: "repo-1",
        name: "c-fork",
      }),
    });
    expect(match).toBeNull();
  });

  it("refuses a suffix-shaped name that isn't a numeric allocator variant", () => {
    // `main-fork-bug` shares the `<placeholder>-` prefix but the
    // suffix isn't a positive integer — that's a human-chosen name,
    // not an allocator-suffix collision. Must not match.
    const match = findPendingPlaceholderForCreatedWorkspace({
      workspaces: [
        placeholder("pending-fork-1", "repo-1", "main-fork"),
      ],
      pendingCreates: {},
      pendingForks: { "pending-fork-1": "ws-source" },
      real: makeWorkspace({
        id: "ws-real",
        repository_id: "repo-1",
        name: "main-fork-bug",
      }),
    });
    expect(match).toBeNull();
  });

  it("refuses suffixes the allocator never emits (-0, -1, -01)", () => {
    // `workspace_alloc.rs` starts at attempt+1=2 — `-0` and `-1`
    // can only come from manual renames or an unrelated workspace.
    // Match them and we'd false-swap a real `<placeholder>-1` into
    // the optimistic placeholder slot, hijacking the user's
    // selection. Same for leading-zero variants — the allocator's
    // `format!("...-{}", n)` never pads.
    for (const badSuffix of ["main-fork-0", "main-fork-1", "main-fork-01"]) {
      const match = findPendingPlaceholderForCreatedWorkspace({
        workspaces: [
          placeholder("pending-fork-1", "repo-1", "main-fork"),
        ],
        pendingCreates: {},
        pendingForks: { "pending-fork-1": "ws-source" },
        real: makeWorkspace({
          id: "ws-real",
          repository_id: "repo-1",
          name: badSuffix,
        }),
      });
      expect(match, `suffix ${badSuffix} must NOT match`).toBeNull();
    }
  });

  it("refuses the fallback when multiple placeholders are in flight", () => {
    // Two concurrent forks against the same repo: even an
    // allocator-suffix match is ambiguous because we can't tell which
    // placeholder the suffix-bearing name resolves to. Skip the eager
    // swap; the IPC return handler will commit them in order.
    const match = findPendingPlaceholderForCreatedWorkspace({
      workspaces: [
        placeholder("pending-fork-1", "repo-1", "a-fork"),
        placeholder("pending-fork-2", "repo-1", "a-fork"),
      ],
      pendingCreates: {},
      pendingForks: {
        "pending-fork-1": "ws-a",
        "pending-fork-2": "ws-a",
      },
      real: makeWorkspace({
        id: "ws-real",
        repository_id: "repo-1",
        name: "a-fork-2",
      }),
    });
    expect(match).toBeNull();
  });

  it("prefers an exact name match over the single-placeholder fallback", () => {
    const match = findPendingPlaceholderForCreatedWorkspace({
      workspaces: [
        placeholder("pending-create-1", "repo-1", "lemur-snow"),
        placeholder("pending-fork-1", "repo-1", "anything"),
      ],
      pendingCreates: { "pending-create-1": "repo-1" },
      pendingForks: { "pending-fork-1": "ws-source" },
      real: makeWorkspace({
        id: "ws-real",
        repository_id: "repo-1",
        name: "lemur-snow",
      }),
    });
    expect(match).toEqual({
      placeholderId: "pending-create-1",
      from: "create",
    });
  });
});
