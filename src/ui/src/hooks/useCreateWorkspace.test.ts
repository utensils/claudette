import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock fns so vi.mock factories can reference them.
const {
  mockGenerateWorkspaceName,
  mockCreateWorkspace,
  mockGetRepoConfig,
  mockRunWorkspaceSetup,
} = vi.hoisted(() => ({
  mockGenerateWorkspaceName: vi.fn(),
  mockCreateWorkspace: vi.fn(),
  mockGetRepoConfig: vi.fn(),
  mockRunWorkspaceSetup: vi.fn(),
}));

vi.mock("../services/tauri", () => ({
  generateWorkspaceName: mockGenerateWorkspaceName,
  createWorkspace: mockCreateWorkspace,
  getRepoConfig: mockGetRepoConfig,
  runWorkspaceSetup: mockRunWorkspaceSetup,
  // Tests exercise `selectWorkspace` on the store, which now notifies the
  // backend so the SCM polling loop can promote the new workspace into its
  // hot tier. The notification is fire-and-forget — stub it so the mock
  // surface stays complete.
  notifyWorkspaceSelected: vi.fn(() => Promise.resolve()),
}));

import {
  __resetCreateWorkspaceOrchestrationForTests,
  createWorkspaceOrchestrated,
} from "./useCreateWorkspace";
import { useAppStore } from "../stores/useAppStore";
import type { Repository } from "../types/repository";
import type { Workspace } from "../types";

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-1",
    path: "/tmp/repo-1",
    name: "repo-1",
    path_slug: "repo-1",
    icon: null,
    created_at: "2026-01-01T00:00:00Z",
    setup_script: null,
    custom_instructions: null,
    sort_order: 0,
    branch_rename_preferences: null,
    setup_script_auto_run: false,
    archive_script: null,
    archive_script_auto_run: false,
    base_branch: null,
    default_remote: null,
    path_valid: true,
    remote_connection_id: null,
    ...overrides,
  };
}

function makeWorkspace(id: string, repoId = "repo-1"): Workspace {
  return {
    id,
    repository_id: repoId,
    name: `ws-${id}`,
    branch_name: "main",
    worktree_path: `/tmp/${id}`,
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "2026-01-01T00:00:00Z",
    sort_order: 0,
    remote_connection_id: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCreateWorkspaceOrchestrationForTests();
  // Reset only the slices the orchestrator touches; leave the rest of the
  // store at its initial value so unrelated selectors don't surprise us.
  useAppStore.setState({
    repositories: [],
    workspaces: [],
    selectedWorkspaceId: null,
    creatingWorkspaceRepoId: null,
    repoCollapsed: {},
    chatMessages: {},
    activeModal: null,
    modalData: {},
  });
});

afterEach(() => {
  __resetCreateWorkspaceOrchestrationForTests();
  useAppStore.setState({ creatingWorkspaceRepoId: null });
});

describe("createWorkspaceOrchestrated", () => {
  it("publishes creatingWorkspaceRepoId immediately and clears it on resolve", async () => {
    mockGenerateWorkspaceName.mockResolvedValue({
      slug: "calm-protea",
      display: "calm protea",
      message: null,
    });
    mockCreateWorkspace.mockResolvedValue({
      workspace: makeWorkspace("w1"),
      default_session_id: "s1",
      setup_result: null,
    });
    mockGetRepoConfig.mockRejectedValue(new Error("no config"));

    const seen: (string | null)[] = [];
    const unsub = useAppStore.subscribe((s, prev) => {
      if (s.creatingWorkspaceRepoId !== prev.creatingWorkspaceRepoId) {
        seen.push(s.creatingWorkspaceRepoId);
      }
    });

    const out = await createWorkspaceOrchestrated("repo-1");
    unsub();

    expect(out).toEqual({ workspaceId: "w1", sessionId: "s1" });
    // Optimistic feedback: we must transition to "repo-1" before resolving,
    // and back to null on completion. The exact intermediate ordering
    // doesn't matter, but both transitions must show up.
    expect(seen).toContain("repo-1");
    expect(seen[seen.length - 1]).toBeNull();
    expect(useAppStore.getState().creatingWorkspaceRepoId).toBeNull();
  });

  it("dedupes a second concurrent call with the same default key", async () => {
    // Hold createWorkspace open until we've fired the second call. This is
    // the regression we care about — without the module-level guard, the
    // welcome card's CTA + Cmd+Shift+N hotkey could double-create when
    // pressed in quick succession.
    let release!: (v: {
      workspace: Workspace;
      default_session_id: string;
      setup_result: null;
    }) => void;
    const pending = new Promise<{
      workspace: Workspace;
      default_session_id: string;
      setup_result: null;
    }>((resolve) => {
      release = resolve;
    });
    mockGenerateWorkspaceName.mockResolvedValue({
      slug: "calm-protea",
      display: "calm protea",
      message: null,
    });
    mockCreateWorkspace.mockReturnValueOnce(pending);
    mockGetRepoConfig.mockRejectedValue(new Error("no config"));

    const first = createWorkspaceOrchestrated("repo-1");
    // Yield once so `first` claims the default idempotency key and
    // the awaited generateWorkspaceName resolves.
    await Promise.resolve();
    await Promise.resolve();

    const second = await createWorkspaceOrchestrated("repo-1");
    expect(second).toBeNull();
    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);

    release({
      workspace: makeWorkspace("w1"),
      default_session_id: "s1",
      setup_result: null,
    });
    const firstResult = await first;
    expect(firstResult).toEqual({ workspaceId: "w1", sessionId: "s1" });

    // After the first resolves the key must release so a fresh call
    // can proceed — the guard is not a permanent kill switch.
    mockCreateWorkspace.mockResolvedValueOnce({
      workspace: makeWorkspace("w2"),
      default_session_id: "s2",
      setup_result: null,
    });
    const third = await createWorkspaceOrchestrated("repo-1");
    expect(third).toEqual({ workspaceId: "w2", sessionId: "s2" });
  });

  it("queues concurrent calls with distinct idempotency keys", async () => {
    let releaseFirst!: (v: {
      workspace: Workspace;
      default_session_id: string;
      setup_result: null;
    }) => void;
    const firstPending = new Promise<{
      workspace: Workspace;
      default_session_id: string;
      setup_result: null;
    }>((resolve) => {
      releaseFirst = resolve;
    });
    mockGenerateWorkspaceName
      .mockResolvedValueOnce({
        slug: "calm-protea",
        display: "calm protea",
        message: null,
      })
      .mockResolvedValueOnce({
        slug: "bold-aster",
        display: "bold aster",
        message: null,
      });
    mockCreateWorkspace
      .mockReturnValueOnce(firstPending)
      .mockResolvedValueOnce({
        workspace: makeWorkspace("w2"),
        default_session_id: "s2",
        setup_result: null,
      });
    mockGetRepoConfig.mockRejectedValue(new Error("no config"));

    const first = createWorkspaceOrchestrated("repo-1", {
      idempotencyKey: "issue-1",
    });
    await Promise.resolve();
    await Promise.resolve();

    const second = createWorkspaceOrchestrated("repo-1", {
      idempotencyKey: "issue-2",
    });
    await Promise.resolve();
    await Promise.resolve();

    // The second create is queued behind the first, not rejected and
    // not allowed to collide with the backend's per-repo guard.
    expect(mockGenerateWorkspaceName).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);

    releaseFirst({
      workspace: makeWorkspace("w1"),
      default_session_id: "s1",
      setup_result: null,
    });

    await expect(first).resolves.toEqual({
      workspaceId: "w1",
      sessionId: "s1",
    });
    await expect(second).resolves.toEqual({
      workspaceId: "w2",
      sessionId: "s2",
    });
    expect(mockCreateWorkspace).toHaveBeenNthCalledWith(
      1,
      "repo-1",
      "calm-protea",
      true,
    );
    expect(mockCreateWorkspace).toHaveBeenNthCalledWith(
      2,
      "repo-1",
      "bold-aster",
      true,
    );
  });

  it("auto-runs the setup script when the repo opted in", async () => {
    useAppStore.setState({
      repositories: [
        makeRepo({ setup_script: "echo hi", setup_script_auto_run: true }),
      ],
    });
    mockGenerateWorkspaceName.mockResolvedValue({
      slug: "calm-protea",
      display: "calm protea",
      message: null,
    });
    mockCreateWorkspace.mockResolvedValue({
      workspace: makeWorkspace("w1"),
      default_session_id: "s1",
      setup_result: null,
    });
    mockGetRepoConfig.mockResolvedValue({
      has_config_file: false,
      setup_script: null,
      archive_script: null,
      instructions: null,
      parse_error: null,
    });
    mockRunWorkspaceSetup.mockResolvedValue(null);

    await createWorkspaceOrchestrated("repo-1");

    expect(mockRunWorkspaceSetup).toHaveBeenCalledWith("w1");
    // Auto-run path must NOT open the prompt modal — that path is
    // explicitly the alternative branch.
    expect(useAppStore.getState().activeModal).toBeNull();
  });

  it("opens the confirmSetupScript modal when the repo did NOT opt in", async () => {
    useAppStore.setState({
      repositories: [
        makeRepo({ setup_script: "echo hi", setup_script_auto_run: false }),
      ],
    });
    mockGenerateWorkspaceName.mockResolvedValue({
      slug: "calm-protea",
      display: "calm protea",
      message: null,
    });
    mockCreateWorkspace.mockResolvedValue({
      workspace: makeWorkspace("w1"),
      default_session_id: "s1",
      setup_result: null,
    });
    mockGetRepoConfig.mockResolvedValue({
      has_config_file: false,
      setup_script: null,
      archive_script: null,
      instructions: null,
      parse_error: null,
    });

    await createWorkspaceOrchestrated("repo-1");

    expect(mockRunWorkspaceSetup).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeModal).toBe("confirmSetupScript");
    expect(useAppStore.getState().modalData).toMatchObject({
      workspaceId: "w1",
      sessionId: "s1",
      repoId: "repo-1",
      script: "echo hi",
    });
  });

  it("expands the parent repo group and selects the new workspace by default", async () => {
    useAppStore.setState({ repoCollapsed: { "repo-1": true } });
    mockGenerateWorkspaceName.mockResolvedValue({
      slug: "calm-protea",
      display: "calm protea",
      message: null,
    });
    mockCreateWorkspace.mockResolvedValue({
      workspace: makeWorkspace("w1"),
      default_session_id: "s1",
      setup_result: null,
    });
    mockGetRepoConfig.mockRejectedValue(new Error("no config"));

    await createWorkspaceOrchestrated("repo-1");

    const post = useAppStore.getState();
    expect(post.repoCollapsed["repo-1"]).toBeUndefined();
    expect(post.selectedWorkspaceId).toBe("w1");
  });

  it("respects selectOnCreate=false (sidebar `+` button case)", async () => {
    mockGenerateWorkspaceName.mockResolvedValue({
      slug: "calm-protea",
      display: "calm protea",
      message: null,
    });
    mockCreateWorkspace.mockResolvedValue({
      workspace: makeWorkspace("w1"),
      default_session_id: "s1",
      setup_result: null,
    });
    mockGetRepoConfig.mockRejectedValue(new Error("no config"));

    await createWorkspaceOrchestrated("repo-1", { selectOnCreate: false });
    expect(useAppStore.getState().selectedWorkspaceId).toBeNull();
  });

  it("clears the in-flight key even when createWorkspace throws", async () => {
    mockGenerateWorkspaceName.mockResolvedValue({
      slug: "calm-protea",
      display: "calm protea",
      message: null,
    });
    mockCreateWorkspace.mockRejectedValue(new Error("disk full"));
    // Silence the orchestrator's own console.error so the test output stays
    // clean — we still assert the rejection below.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createWorkspaceOrchestrated("repo-1")).rejects.toThrow(
      "disk full",
    );
    expect(useAppStore.getState().creatingWorkspaceRepoId).toBeNull();

    // And a follow-up call must succeed — the guard is reset in `finally`.
    mockCreateWorkspace.mockResolvedValueOnce({
      workspace: makeWorkspace("w2"),
      default_session_id: "s2",
      setup_result: null,
    });
    mockGetRepoConfig.mockRejectedValue(new Error("no config"));
    const out = await createWorkspaceOrchestrated("repo-1");
    expect(out).toEqual({ workspaceId: "w2", sessionId: "s2" });

    errSpy.mockRestore();
  });

  it("treats the backend in-flight rejection as benign: toast, null, restored selection, no error log", async () => {
    // The backend's `create_workspace` refuses a second create for a repo
    // that already has one running (issue #896). That guard survives a
    // webview reload — unlike the module-level key set — so the orchestrator
    // must treat the rejection as benign: surface a calm toast, return
    // null (the same shape as the in-process idempotency early-return),
    // restore the pre-create selection rather than yanking the user to
    // the dashboard, and not log it at error level (nothing failed).
    const addToast = vi.fn();
    // A workspace the user was viewing before clicking New — the
    // optimistic placeholder briefly steals selection, so the benign
    // rejection must restore selection to this row, not null it.
    const prior = makeWorkspace("prior");
    useAppStore.setState({
      addToast,
      workspaces: [prior],
      selectedWorkspaceId: prior.id,
    });
    mockGenerateWorkspaceName.mockResolvedValue({
      slug: "calm-protea",
      display: "calm protea",
      message: null,
    });
    // The backend returns the bare error code (not a sentence) so the
    // cross-process contract is a fixed token — see
    // `WORKSPACE_CREATE_IN_FLIGHT_ERR` in `commands/workspace.rs`.
    mockCreateWorkspace.mockRejectedValue(
      new Error("WORKSPACE_CREATE_IN_FLIGHT"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await createWorkspaceOrchestrated("repo-1");
    expect(out).toBeNull();

    // A toast was surfaced and the key released so a retry can proceed.
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0][0]).toMatch(/already being created/i);
    expect(useAppStore.getState().creatingWorkspaceRepoId).toBeNull();
    // Selection is restored to where the user was — not nulled to the
    // dashboard — and the benign rejection is never logged as a failure.
    expect(useAppStore.getState().selectedWorkspaceId).toBe(prior.id);
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
