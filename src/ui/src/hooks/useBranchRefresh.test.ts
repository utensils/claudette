import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRefreshBranches, mockRefreshWorkspaceBranch } = vi.hoisted(() => ({
  mockRefreshBranches: vi.fn(),
  mockRefreshWorkspaceBranch: vi.fn(),
}));

vi.mock("../services/tauri", () => ({
  refreshBranches: mockRefreshBranches,
  refreshWorkspaceBranch: mockRefreshWorkspaceBranch,
}));

import {
  BRANCH_POLL_BASE_MS,
  BRANCH_POLL_MAX_MS,
  nextBranchPollDelay,
  pollAndApplyBranchUpdates,
  refreshSelectedWorkspaceBranch,
} from "./useBranchRefresh";

describe("pollAndApplyBranchUpdates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes only the workspaces whose backend branch differs from the store", async () => {
    // Backend reports two workspaces (level-triggered). Only one differs
    // from the store value — that's the only one we should write.
    mockRefreshBranches.mockResolvedValue([
      ["w1", "user/renamed"],
      ["w2", "feature/new"],
    ]);
    const updateWorkspace = vi.fn();
    const getCurrentBranch = vi.fn((id: string) =>
      id === "w1" ? "user/renamed" : "feature/old",
    );

    const applied = await pollAndApplyBranchUpdates(
      updateWorkspace,
      getCurrentBranch,
    );

    expect(applied).toBe(1);
    expect(updateWorkspace).toHaveBeenCalledTimes(1);
    expect(updateWorkspace).toHaveBeenCalledWith("w2", {
      branch_name: "feature/new",
    });
  });

  it("returns zero and writes nothing when every backend value matches the store", async () => {
    // Steady state under level-triggered semantics: backend reports every
    // active workspace, but nothing has actually drifted. The hook must
    // not call updateWorkspace at all so the back-off can grow.
    mockRefreshBranches.mockResolvedValue([
      ["w1", "main"],
      ["w2", "feature"],
    ]);
    const updateWorkspace = vi.fn();
    const getCurrentBranch = vi.fn((id: string) =>
      id === "w1" ? "main" : "feature",
    );

    const applied = await pollAndApplyBranchUpdates(
      updateWorkspace,
      getCurrentBranch,
    );

    expect(applied).toBe(0);
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("returns zero and writes nothing when the backend returns an empty list", async () => {
    mockRefreshBranches.mockResolvedValue([]);
    const updateWorkspace = vi.fn();
    const getCurrentBranch = vi.fn(() => "main");

    const applied = await pollAndApplyBranchUpdates(
      updateWorkspace,
      getCurrentBranch,
    );

    expect(applied).toBe(0);
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("returns zero on backend error so the polling loop keeps running", async () => {
    mockRefreshBranches.mockRejectedValue(new Error("IPC down"));
    const updateWorkspace = vi.fn();
    const getCurrentBranch = vi.fn(() => "main");

    const applied = await pollAndApplyBranchUpdates(
      updateWorkspace,
      getCurrentBranch,
    );

    expect(applied).toBe(0);
    expect(updateWorkspace).not.toHaveBeenCalled();
  });
});

describe("nextBranchPollDelay", () => {
  it("returns the base interval after a poll that observed drift", () => {
    expect(nextBranchPollDelay(0)).toBe(BRANCH_POLL_BASE_MS);
  });

  it("doubles the interval on each consecutive empty poll", () => {
    expect(nextBranchPollDelay(1)).toBe(BRANCH_POLL_BASE_MS * 2);
    expect(nextBranchPollDelay(2)).toBe(BRANCH_POLL_BASE_MS * 4);
  });

  it("never grows beyond the cap", () => {
    expect(nextBranchPollDelay(10)).toBe(BRANCH_POLL_MAX_MS);
    expect(nextBranchPollDelay(100)).toBe(BRANCH_POLL_MAX_MS);
  });
});

describe("refreshSelectedWorkspaceBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the fresh branch to the store when the backend value differs from the store", async () => {
    mockRefreshWorkspaceBranch.mockResolvedValue("user/renamed");
    const updateWorkspace = vi.fn();
    const getCurrentBranch = vi.fn(() => "main");

    const result = await refreshSelectedWorkspaceBranch(
      "w1",
      updateWorkspace,
      getCurrentBranch,
    );

    expect(result).toBe("user/renamed");
    expect(mockRefreshWorkspaceBranch).toHaveBeenCalledWith("w1");
    expect(updateWorkspace).toHaveBeenCalledWith("w1", {
      branch_name: "user/renamed",
    });
  });

  it("returns the resolved branch but skips the store write when it matches", async () => {
    // Level-triggered: backend always returns the current branch. When the
    // store already agrees, we should not trigger a re-render.
    mockRefreshWorkspaceBranch.mockResolvedValue("main");
    const updateWorkspace = vi.fn();
    const getCurrentBranch = vi.fn(() => "main");

    const result = await refreshSelectedWorkspaceBranch(
      "w1",
      updateWorkspace,
      getCurrentBranch,
    );

    expect(result).toBe("main");
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("leaves the store untouched when the backend returns null", async () => {
    mockRefreshWorkspaceBranch.mockResolvedValue(null);
    const updateWorkspace = vi.fn();
    const getCurrentBranch = vi.fn(() => "main");

    const result = await refreshSelectedWorkspaceBranch(
      "w1",
      updateWorkspace,
      getCurrentBranch,
    );

    expect(result).toBeNull();
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("returns null and skips the write on backend failure", async () => {
    mockRefreshWorkspaceBranch.mockRejectedValue(
      new Error("workspace gone"),
    );
    const updateWorkspace = vi.fn();
    const getCurrentBranch = vi.fn(() => "main");

    const result = await refreshSelectedWorkspaceBranch(
      "w1",
      updateWorkspace,
      getCurrentBranch,
    );

    expect(result).toBeNull();
    expect(updateWorkspace).not.toHaveBeenCalled();
  });
});
