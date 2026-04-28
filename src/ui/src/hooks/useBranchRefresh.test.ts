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

  it("applies every drift returned by the backend and reports the count", async () => {
    mockRefreshBranches.mockResolvedValue([
      ["w1", "user/renamed"],
      ["w2", "feature/new"],
    ]);
    const updateWorkspace = vi.fn();

    const applied = await pollAndApplyBranchUpdates(updateWorkspace);

    expect(applied).toBe(2);
    expect(updateWorkspace).toHaveBeenCalledTimes(2);
    expect(updateWorkspace).toHaveBeenNthCalledWith(1, "w1", {
      branch_name: "user/renamed",
    });
    expect(updateWorkspace).toHaveBeenNthCalledWith(2, "w2", {
      branch_name: "feature/new",
    });
  });

  it("returns zero and writes nothing when the backend returns no drift", async () => {
    mockRefreshBranches.mockResolvedValue([]);
    const updateWorkspace = vi.fn();

    const applied = await pollAndApplyBranchUpdates(updateWorkspace);

    expect(applied).toBe(0);
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("returns zero on backend error so the polling loop keeps running", async () => {
    mockRefreshBranches.mockRejectedValue(new Error("IPC down"));
    const updateWorkspace = vi.fn();

    const applied = await pollAndApplyBranchUpdates(updateWorkspace);

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

  it("writes the fresh branch to the store when the backend reports drift", async () => {
    mockRefreshWorkspaceBranch.mockResolvedValue("user/renamed");
    const updateWorkspace = vi.fn();

    const result = await refreshSelectedWorkspaceBranch("w1", updateWorkspace);

    expect(result).toBe("user/renamed");
    expect(mockRefreshWorkspaceBranch).toHaveBeenCalledWith("w1");
    expect(updateWorkspace).toHaveBeenCalledWith("w1", {
      branch_name: "user/renamed",
    });
  });

  it("leaves the store untouched when there is no drift", async () => {
    mockRefreshWorkspaceBranch.mockResolvedValue(null);
    const updateWorkspace = vi.fn();

    const result = await refreshSelectedWorkspaceBranch("w1", updateWorkspace);

    expect(result).toBeNull();
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("returns null and skips the write on backend failure", async () => {
    mockRefreshWorkspaceBranch.mockRejectedValue(
      new Error("workspace gone"),
    );
    const updateWorkspace = vi.fn();

    const result = await refreshSelectedWorkspaceBranch("w1", updateWorkspace);

    expect(result).toBeNull();
    expect(updateWorkspace).not.toHaveBeenCalled();
  });
});
