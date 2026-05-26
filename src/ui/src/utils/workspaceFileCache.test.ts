import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  getCachedWorkspaceFiles,
  getStaleWorkspaceFiles,
  loadWorkspaceFilesCached,
} from "./workspaceFileCache";
import type { FileEntry } from "../services/tauri";

const serviceMocks = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
}));

vi.mock("../services/tauri", () => ({
  listWorkspaceFiles: serviceMocks.listWorkspaceFiles,
}));

function entries(paths: string[]): FileEntry[] {
  return paths.map((path) => ({ path, is_directory: false }));
}

beforeEach(() => {
  __testing.reset();
  serviceMocks.listWorkspaceFiles.mockReset();
});

describe("workspaceFileCache", () => {
  it("deduplicates concurrent loads for the same workspace and nonce", async () => {
    const loaded = entries(["src/main.ts"]);
    serviceMocks.listWorkspaceFiles.mockResolvedValue(loaded);

    const [first, second] = await Promise.all([
      loadWorkspaceFilesCached("ws-a", 0),
      loadWorkspaceFilesCached("ws-a", 0),
    ]);

    expect(serviceMocks.listWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(first).toBe(loaded);
    expect(second).toBe(loaded);
    expect(getCachedWorkspaceFiles("ws-a", 0)).toBe(loaded);
  });

  it("keeps stale entries visible while a newer nonce refresh is in flight", async () => {
    const stale = entries(["src/stale.ts"]);
    const fresh = entries(["src/fresh.ts"]);
    serviceMocks.listWorkspaceFiles
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(fresh);

    await loadWorkspaceFilesCached("ws-a", 0);
    const refreshing = loadWorkspaceFilesCached("ws-a", 1);

    expect(getCachedWorkspaceFiles("ws-a", 1)).toBeNull();
    expect(getStaleWorkspaceFiles("ws-a")).toBe(stale);

    await refreshing;
    expect(getCachedWorkspaceFiles("ws-a", 1)).toBe(fresh);
  });

  it("does not cache failed refresh promises", async () => {
    serviceMocks.listWorkspaceFiles
      .mockRejectedValueOnce(new Error("git failed"))
      .mockResolvedValueOnce(entries(["README.md"]));

    await expect(loadWorkspaceFilesCached("ws-a", 0)).rejects.toThrow("git failed");
    await expect(loadWorkspaceFilesCached("ws-a", 0)).resolves.toEqual([
      { path: "README.md", is_directory: false },
    ]);

    expect(serviceMocks.listWorkspaceFiles).toHaveBeenCalledTimes(2);
  });

  it("keeps an older successful response as stale data when a newer uncached refresh is active", async () => {
    const stale = entries(["src/older.ts"]);
    const newer = new Promise<FileEntry[]>((_resolve, reject) => {
      setTimeout(() => reject(new Error("newer failed")), 0);
    });
    serviceMocks.listWorkspaceFiles
      .mockReturnValueOnce(Promise.resolve(stale))
      .mockReturnValueOnce(newer);

    const olderPromise = loadWorkspaceFilesCached("ws-a", 0);
    const newerPromise = loadWorkspaceFilesCached("ws-a", 1);

    await olderPromise;
    expect(getCachedWorkspaceFiles("ws-a", 1)).toBeNull();
    expect(getStaleWorkspaceFiles("ws-a")).toBe(stale);

    await expect(newerPromise).rejects.toThrow("newer failed");
    expect(getStaleWorkspaceFiles("ws-a")).toBe(stale);
  });
});
