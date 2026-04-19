import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (vi.hoisted runs before vi.mock factories) ────────────────
const {
  mockCheckForUpdatesWithChannel,
  mockSetUpdateAvailable,
  storeState,
} = vi.hoisted(() => ({
  mockCheckForUpdatesWithChannel: vi.fn(),
  mockSetUpdateAvailable: vi.fn(),
  storeState: {
    setUpdateAvailable: vi.fn(),
    updateDownloading: false,
    workspaces: [] as { agent_status: string }[],
    updateChannel: "stable" as "stable" | "nightly",
  },
}));

// Wire the hoisted helpers into the store mock.
storeState.setUpdateAvailable = mockSetUpdateAvailable;

vi.mock("../services/tauri", () => ({
  checkForUpdatesWithChannel: mockCheckForUpdatesWithChannel,
  installPendingUpdate: vi.fn(),
  getAppSetting: vi.fn().mockResolvedValue(null),
  setAppSetting: vi.fn().mockResolvedValue(undefined),
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
import { checkForUpdate } from "./useAutoUpdater";

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
