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
  pollAndApplyBranchUpdates,
  refreshSelectedWorkspaceBranch,
} from "./useBranchRefresh";

describe("pollAndApplyBranchUpdates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies every drift returned by the backend", async () => {
    mockRefreshBranches.mockResolvedValue([
      ["w1", "user/renamed"],
      ["w2", "feature/new"],
    ]);
    const updateWorkspace = vi.fn();

    await pollAndApplyBranchUpdates(updateWorkspace);

    expect(updateWorkspace).toHaveBeenCalledTimes(2);
    expect(updateWorkspace).toHaveBeenNthCalledWith(1, "w1", {
      branch_name: "user/renamed",
    });
    expect(updateWorkspace).toHaveBeenNthCalledWith(2, "w2", {
      branch_name: "feature/new",
    });
  });

  it("makes no store writes when the backend returns no drift", async () => {
    mockRefreshBranches.mockResolvedValue([]);
    const updateWorkspace = vi.fn();

    await pollAndApplyBranchUpdates(updateWorkspace);

    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("swallows errors so the polling loop keeps running", async () => {
    mockRefreshBranches.mockRejectedValue(new Error("IPC down"));
    const updateWorkspace = vi.fn();

    await expect(
      pollAndApplyBranchUpdates(updateWorkspace),
    ).resolves.toBeUndefined();
    expect(updateWorkspace).not.toHaveBeenCalled();
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
