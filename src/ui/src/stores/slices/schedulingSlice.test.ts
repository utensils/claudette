import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listScheduledRoutines: vi.fn(),
  listScheduledTaskRuns: vi.fn(),
  listChatSessions: vi.fn(),
}));

vi.mock("../../services/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tauri")>();
  return {
    ...actual,
    listScheduledRoutines: mocks.listScheduledRoutines,
    listScheduledTaskRuns: mocks.listScheduledTaskRuns,
    listChatSessions: mocks.listChatSessions,
  };
});

import { useAppStore } from "../useAppStore";

describe("schedulingSlice.loadScheduledTasks", () => {
  beforeEach(() => {
    mocks.listScheduledRoutines.mockReset();
    mocks.listScheduledTaskRuns.mockReset().mockResolvedValue([]);
    mocks.listChatSessions.mockReset().mockResolvedValue([]);
    useAppStore.setState({
      scheduledTasks: [],
      recentScheduledRuns: [],
      sessionsByWorkspace: {},
      sessionsLoadedByWorkspace: {},
    });
  });

  it("re-runs once when called during an in-flight load", async () => {
    let release: (v: unknown[]) => void = () => {};
    mocks.listScheduledRoutines
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValueOnce([{ id: "fresh" }]);

    const first = useAppStore.getState().loadScheduledTasks();
    // Two change events land mid-request; they coalesce into one reload.
    void useAppStore.getState().loadScheduledTasks();
    void useAppStore.getState().loadScheduledTasks();
    release([{ id: "stale" }]);
    await first;
    await vi.waitFor(() =>
      expect(useAppStore.getState().scheduledTasks).toEqual([{ id: "fresh" }]),
    );
    expect(mocks.listScheduledRoutines).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous list when the backend errors", async () => {
    useAppStore.setState({ scheduledTasks: [{ id: "kept" }] as never });
    mocks.listScheduledRoutines.mockRejectedValueOnce(new Error("db locked"));
    await useAppStore.getState().loadScheduledTasks();
    expect(useAppStore.getState().scheduledTasks).toEqual([{ id: "kept" }]);
  });

  it("preloads sessions for task workspaces that aren't loaded yet", async () => {
    useAppStore.setState({ sessionsLoadedByWorkspace: { wsOpen: true } });
    mocks.listScheduledRoutines.mockResolvedValueOnce([
      { id: "a", workspace_id: "wsOpen" },
      { id: "b", workspace_id: "wsCold" },
      { id: "c", workspace_id: "wsCold" },
    ]);
    mocks.listChatSessions.mockResolvedValueOnce([{ id: "s1", workspace_id: "wsCold" }]);
    await useAppStore.getState().loadScheduledTasks();
    await vi.waitFor(() =>
      expect(useAppStore.getState().sessionsLoadedByWorkspace.wsCold).toBe(true),
    );
    expect(mocks.listChatSessions).toHaveBeenCalledTimes(1);
    expect(mocks.listChatSessions).toHaveBeenCalledWith("wsCold");
  });
});
