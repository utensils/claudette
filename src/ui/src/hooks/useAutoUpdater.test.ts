import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (vi.hoisted runs before vi.mock factories) ────────────────
const {
  mockCheckForUpdatesWithChannel,
  mockInstallPendingUpdate,
  mockGetAppSetting,
  mockSetAppSetting,
  mockSetUpdateAvailable,
  mockSetUpdateChannel,
  mockSetUpdateDownloading,
  mockSetUpdateProgress,
  mockSetUpdateError,
  mockSetUpdateDismissed,
  mockSetUpdateInstallWhenIdle,
  storeState,
} = vi.hoisted(() => ({
  mockCheckForUpdatesWithChannel: vi.fn(),
  mockInstallPendingUpdate: vi.fn(),
  mockGetAppSetting: vi.fn(),
  mockSetAppSetting: vi.fn(),
  mockSetUpdateAvailable: vi.fn(),
  mockSetUpdateChannel: vi.fn(),
  mockSetUpdateDownloading: vi.fn(),
  mockSetUpdateProgress: vi.fn(),
  mockSetUpdateError: vi.fn(),
  mockSetUpdateDismissed: vi.fn(),
  mockSetUpdateInstallWhenIdle: vi.fn(),
  storeState: {
    setUpdateAvailable: vi.fn(),
    setUpdateChannel: vi.fn(),
    setUpdateDownloading: vi.fn(),
    setUpdateProgress: vi.fn(),
    setUpdateError: vi.fn(),
    setUpdateDismissed: vi.fn(),
    setUpdateInstallWhenIdle: vi.fn(),
    updateDownloading: false,
    updateAvailable: false,
    workspaces: [] as { agent_status: string }[],
    updateChannel: "stable" as "stable" | "nightly",
  },
}));

// Wire the hoisted helpers into the store mock.
storeState.setUpdateAvailable = mockSetUpdateAvailable;
storeState.setUpdateChannel = mockSetUpdateChannel;
storeState.setUpdateDownloading = mockSetUpdateDownloading;
storeState.setUpdateProgress = mockSetUpdateProgress;
storeState.setUpdateError = mockSetUpdateError;
storeState.setUpdateDismissed = mockSetUpdateDismissed;
storeState.setUpdateInstallWhenIdle = mockSetUpdateInstallWhenIdle;

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
  installNow,
  retryInstall,
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

describe("installNow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.updateChannel = "stable";
    storeState.updateDownloading = false;
    storeState.updateAvailable = true;
  });

  it("surfaces install errors via setUpdateError so the banner can show them", async () => {
    // Regression: a previous version swallowed the failure and re-ran the
    // check, leaving the banner stuck on "Downloading..." forever. The fix
    // is to push the error string into the store so the banner can render
    // the failure and offer a retry.
    mockInstallPendingUpdate.mockRejectedValue(
      new Error("Download request failed with status: 404 Not Found")
    );

    await installNow();

    expect(mockSetUpdateDownloading).toHaveBeenCalledWith(true);
    expect(mockSetUpdateDownloading).toHaveBeenLastCalledWith(false);
    expect(mockSetUpdateProgress).toHaveBeenLastCalledWith(0);
    expect(mockSetUpdateError).toHaveBeenCalledWith(
      expect.stringContaining("404 Not Found")
    );
  });

  it("is a no-op when no update is available", async () => {
    storeState.updateAvailable = false;

    await installNow();

    expect(mockInstallPendingUpdate).not.toHaveBeenCalled();
    expect(mockSetUpdateDownloading).not.toHaveBeenCalled();
  });

  it("is a no-op when a download is already in flight", async () => {
    storeState.updateDownloading = true;

    await installNow();

    expect(mockInstallPendingUpdate).not.toHaveBeenCalled();
  });
});

describe("retryInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.updateChannel = "stable";
    storeState.updateDownloading = false;
    storeState.updateAvailable = true;
  });

  it("clears the error, re-checks, and re-installs when an update is still available", async () => {
    // The Rust side `take()`s the pending update on the first attempt, so a
    // bare retry would no-op. The retry must re-run the check to repopulate
    // the pending update before installNow can succeed.
    mockCheckForUpdatesWithChannel.mockResolvedValue({ version: "2.0.0" });
    mockInstallPendingUpdate.mockResolvedValue(undefined);

    await retryInstall();

    expect(mockSetUpdateError).toHaveBeenCalledWith(null);
    expect(mockCheckForUpdatesWithChannel).toHaveBeenCalled();
    expect(mockInstallPendingUpdate).toHaveBeenCalled();
  });

  it("does not re-install when the re-check finds no update", async () => {
    mockCheckForUpdatesWithChannel.mockResolvedValue(null);

    await retryInstall();

    expect(mockSetUpdateError).toHaveBeenCalledWith(null);
    expect(mockInstallPendingUpdate).not.toHaveBeenCalled();
  });

  it("un-dismisses the banner and clears install-when-idle so the retry is visible", async () => {
    // If the user previously chose "When Idle" (which sets dismissed=true)
    // and then an install fails, retrying must un-dismiss the banner —
    // otherwise clearing the error makes UpdateBanner render null and the
    // retry runs invisibly with no progress indicator.
    mockCheckForUpdatesWithChannel.mockResolvedValue({ version: "2.0.0" });
    mockInstallPendingUpdate.mockResolvedValue(undefined);

    await retryInstall();

    expect(mockSetUpdateDismissed).toHaveBeenCalledWith(false);
    expect(mockSetUpdateInstallWhenIdle).toHaveBeenCalledWith(false);
  });

  it("re-surfaces a check failure as an error so the user is not left with a blank banner", async () => {
    // The retry clears the previous install error, then re-runs the check.
    // If the check itself fails (e.g. network down), we must repopulate
    // updateError or the banner disappears and the user has no signal that
    // anything happened.
    mockCheckForUpdatesWithChannel.mockRejectedValue(new Error("network down"));

    await retryInstall();

    expect(mockSetUpdateError).toHaveBeenNthCalledWith(1, null);
    expect(mockSetUpdateError).toHaveBeenLastCalledWith(
      expect.stringContaining("Failed to check for updates")
    );
    expect(mockInstallPendingUpdate).not.toHaveBeenCalled();
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
