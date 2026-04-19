import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (vi.hoisted runs before vi.mock factories) ────────────────
const {
  mockCheckForUpdatesWithChannel,
  mockInstallPendingUpdate,
  mockGetAppSetting,
  mockSetAppSetting,
  mockSetUpdateAvailable,
  mockSetUpdateChannel,
  storeState,
} = vi.hoisted(() => ({
  mockCheckForUpdatesWithChannel: vi.fn(),
  mockInstallPendingUpdate: vi.fn(),
  mockGetAppSetting: vi.fn(),
  mockSetAppSetting: vi.fn(),
  mockSetUpdateAvailable: vi.fn(),
  mockSetUpdateChannel: vi.fn(),
  storeState: {
    setUpdateAvailable: vi.fn(),
    setUpdateChannel: vi.fn(),
    updateDownloading: false,
    workspaces: [] as { agent_status: string }[],
    updateChannel: "stable" as "stable" | "nightly",
  },
}));

// Wire the hoisted helpers into the store mock.
storeState.setUpdateAvailable = mockSetUpdateAvailable;
storeState.setUpdateChannel = mockSetUpdateChannel;

vi.mock("../services/tauri", () => ({
  checkForUpdatesWithChannel: mockCheckForUpdatesWithChannel,
  installPendingUpdate: mockInstallPendingUpdate,
  getAppSetting: mockGetAppSetting,
  setAppSetting: mockSetAppSetting,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../stores/useAppStore", () => ({
  useAppStore: Object.assign(() => null, {
    getState: () => storeState,
  }),
}));

// ── Import under test (after mocks) ─────────────────────────────────
import {
  checkForUpdate,
  applyUpdateChannel,
  loadUpdateChannel,
} from "./useAutoUpdater";

describe("checkForUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.updateChannel = "stable";
  });

  it('returns "available" and sets store when an update exists', async () => {
    mockCheckForUpdatesWithChannel.mockResolvedValue({ version: "2.0.0" });

    const result = await checkForUpdate();

    expect(result).toBe("available");
    expect(mockCheckForUpdatesWithChannel).toHaveBeenCalledWith("stable");
    expect(mockSetUpdateAvailable).toHaveBeenCalledWith(true, "2.0.0");
  });

  it('returns "up-to-date" and clears store when no update exists', async () => {
    mockCheckForUpdatesWithChannel.mockResolvedValue(null);

    const result = await checkForUpdate();

    expect(result).toBe("up-to-date");
    expect(mockSetUpdateAvailable).toHaveBeenCalledWith(false, null);
  });

  it('returns "error" and does not touch store when check throws', async () => {
    mockCheckForUpdatesWithChannel.mockRejectedValue(new Error("network failure"));

    const result = await checkForUpdate();

    expect(result).toBe("error");
    expect(mockSetUpdateAvailable).not.toHaveBeenCalled();
  });

  it("passes the active channel through to the Rust command", async () => {
    storeState.updateChannel = "nightly";
    mockCheckForUpdatesWithChannel.mockResolvedValue(null);

    await checkForUpdate();

    expect(mockCheckForUpdatesWithChannel).toHaveBeenCalledWith("nightly");
  });
});

describe("applyUpdateChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.updateChannel = "stable";
    mockSetAppSetting.mockResolvedValue(undefined);
    mockCheckForUpdatesWithChannel.mockResolvedValue(null);
  });

  it("persists the channel before updating the store and triggering a check", async () => {
    // Track call order across the three side effects so a refactor that
    // accidentally swaps them surfaces here.
    const calls: string[] = [];
    mockSetAppSetting.mockImplementation(async () => {
      calls.push("setAppSetting");
    });
    mockSetUpdateChannel.mockImplementation(() => {
      calls.push("setUpdateChannel");
    });
    mockCheckForUpdatesWithChannel.mockImplementation(async () => {
      calls.push("check");
      return null;
    });

    await applyUpdateChannel("nightly");

    expect(mockSetAppSetting).toHaveBeenCalledWith("update_channel", "nightly");
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("nightly");
    // applyUpdateChannel doesn't await the check, so let the microtask queue
    // drain before asserting on it.
    await Promise.resolve();
    expect(calls).toEqual(["setAppSetting", "setUpdateChannel", "check"]);
  });

  it("propagates errors from setAppSetting without touching the store", async () => {
    mockSetAppSetting.mockRejectedValue(new Error("disk full"));

    await expect(applyUpdateChannel("nightly")).rejects.toThrow("disk full");
    expect(mockSetUpdateChannel).not.toHaveBeenCalled();
    expect(mockCheckForUpdatesWithChannel).not.toHaveBeenCalled();
  });
});

describe("loadUpdateChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to stable when no value is persisted", async () => {
    mockGetAppSetting.mockResolvedValue(null);

    const channel = await loadUpdateChannel();

    expect(channel).toBe("stable");
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("stable");
  });

  it("resolves to nightly when persisted as nightly", async () => {
    mockGetAppSetting.mockResolvedValue("nightly");

    const channel = await loadUpdateChannel();

    expect(channel).toBe("nightly");
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("nightly");
  });

  it("falls back to stable when getAppSetting throws", async () => {
    mockGetAppSetting.mockRejectedValue(new Error("db locked"));

    const channel = await loadUpdateChannel();

    expect(channel).toBe("stable");
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("stable");
  });

  it("treats unknown persisted values as stable", async () => {
    mockGetAppSetting.mockResolvedValue("beta");

    const channel = await loadUpdateChannel();

    expect(channel).toBe("stable");
    expect(mockSetUpdateChannel).toHaveBeenCalledWith("stable");
  });
});
