// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/useAppStore";
import type { FileEntry } from "../../services/tauri";
import type { Workspace } from "../../types";
import { __testing as workspaceFileCacheTesting } from "../../utils/workspaceFileCache";
import { FilesPanel } from "./FilesPanel";

const serviceMocks = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  createWorkspaceFile: vi.fn(),
  loadDiffFiles: vi.fn(),
  renameWorkspacePath: vi.fn(),
  restoreWorkspacePathFromTrash: vi.fn(),
  trashWorkspacePath: vi.fn(),
}));

vi.mock("../../services/tauri", () => ({
  listWorkspaceFiles: serviceMocks.listWorkspaceFiles,
  createWorkspaceFile: serviceMocks.createWorkspaceFile,
  loadDiffFiles: serviceMocks.loadDiffFiles,
  renameWorkspacePath: serviceMocks.renameWorkspacePath,
  restoreWorkspacePathFromTrash: serviceMocks.restoreWorkspacePathFromTrash,
  trashWorkspacePath: serviceMocks.trashWorkspacePath,
}));

vi.mock("./FileTree", () => ({
  FileTree: ({ entries }: { entries: FileEntry[] }) => (
    <div>
      {entries.map((entry) => (
        <div key={entry.path}>{entry.path}</div>
      ))}
    </div>
  ),
}));

vi.mock("./FilePathContextMenu", () => ({
  FilePathContextMenu: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeWorkspace(id: string): Workspace {
  return {
    id,
    repository_id: "repo-1",
    name: id,
    branch_name: "main",
    worktree_path: `/tmp/${id}`,
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "2026-05-17T00:00:00Z",
    sort_order: 0,
    input_values: null,
    remote_connection_id: null,
  };
}

function entries(paths: string[]): FileEntry[] {
  return paths.map((path) => ({ path, is_directory: false }));
}

const roots: Root[] = [];
const containers: HTMLElement[] = [];

async function renderPanel(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    root.render(<FilesPanel />);
  });
  return container;
}

async function flushTimers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  workspaceFileCacheTesting.reset();
  serviceMocks.listWorkspaceFiles.mockReset();
  useAppStore.setState({
    selectedWorkspaceId: "files-cache-ws-a",
    workspaces: [
      makeWorkspace("files-cache-ws-a"),
      makeWorkspace("files-cache-ws-b"),
    ],
    fileTreeRefreshNonceByWorkspace: {},
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await act(async () => root.unmount());
  }
  for (const container of containers.splice(0)) container.remove();
});

describe("FilesPanel workspace cache", () => {
  it("renders cached entries immediately when switching back to a workspace", async () => {
    const firstA = deferred<FileEntry[]>();
    const firstB = deferred<FileEntry[]>();
    const secondA = deferred<FileEntry[]>();
    const loads = new Map<string, Deferred<FileEntry[]>[]>([
      ["files-cache-ws-a", [firstA, secondA]],
      ["files-cache-ws-b", [firstB]],
    ]);
    serviceMocks.listWorkspaceFiles.mockImplementation((workspaceId: string) => {
      const next = loads.get(workspaceId)?.shift();
      if (!next) throw new Error(`unexpected load for ${workspaceId}`);
      return next.promise;
    });

    const container = await renderPanel();
    expect(container.textContent).toContain("Loading");

    await flushTimers();
    await act(async () => {
      firstA.resolve(entries(["src/a.ts"]));
      await firstA.promise;
    });
    expect(container.textContent).toContain("src/a.ts");

    await act(async () => {
      useAppStore.setState({ selectedWorkspaceId: "files-cache-ws-b" });
    });
    expect(container.textContent).toContain("Loading");

    await flushTimers();
    await act(async () => {
      firstB.resolve(entries(["src/b.ts"]));
      await firstB.promise;
    });
    expect(container.textContent).toContain("src/b.ts");

    await act(async () => {
      useAppStore.setState({ selectedWorkspaceId: "files-cache-ws-a" });
    });
    expect(container.textContent).toContain("src/a.ts");
    expect(container.textContent).not.toContain("Loading");

    await flushTimers();
    await act(async () => {
      secondA.resolve(entries(["src/a.ts", "src/a-new.ts"]));
      await secondA.promise;
    });
    expect(container.textContent).toContain("src/a-new.ts");
  });

  it("invalidates cached entries when the workspace refresh nonce changes", async () => {
    const first = deferred<FileEntry[]>();
    const refreshed = deferred<FileEntry[]>();
    serviceMocks.listWorkspaceFiles
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(refreshed.promise);

    const container = await renderPanel();
    await flushTimers();
    await act(async () => {
      first.resolve(entries(["src/original.ts"]));
      await first.promise;
    });

    await act(async () => {
      useAppStore.setState({
        fileTreeRefreshNonceByWorkspace: { "files-cache-ws-a": 1 },
      });
    });
    expect(container.textContent).toContain("Loading");
    expect(container.textContent).not.toContain("src/original.ts");

    await flushTimers();
    await act(async () => {
      refreshed.resolve(entries(["src/refreshed.ts"]));
      await refreshed.promise;
    });
    expect(container.textContent).toContain("src/refreshed.ts");
  });

  it("surfaces background refresh failures while keeping cached entries visible", async () => {
    useAppStore.setState({
      selectedWorkspaceId: "files-cache-error-ws-a",
      workspaces: [makeWorkspace("files-cache-error-ws-a")],
      fileTreeRefreshNonceByWorkspace: {},
    });
    const first = deferred<FileEntry[]>();
    serviceMocks.listWorkspaceFiles
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error("git status failed"));

    const container = await renderPanel();
    await flushTimers();
    await act(async () => {
      first.resolve(entries(["src/cached.ts"]));
      await first.promise;
    });

    await act(async () => {
      useAppStore.setState({ selectedWorkspaceId: null });
    });
    await act(async () => {
      useAppStore.setState({ selectedWorkspaceId: "files-cache-error-ws-a" });
    });
    await flushTimers();

    expect(container.textContent).toContain("src/cached.ts");
    expect(container.textContent).toContain("Refresh failed");
    expect(container.textContent).toContain("git status failed");
  });
});
