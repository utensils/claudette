import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { startRemoteDiscovery } from "./tauri";

describe("tauri service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("starts remote discovery on demand", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await expect(startRemoteDiscovery()).resolves.toEqual([]);

    expect(invokeMock).toHaveBeenCalledWith("start_remote_discovery", undefined);
  });
});
