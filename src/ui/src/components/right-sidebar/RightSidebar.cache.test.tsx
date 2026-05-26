// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/useAppStore";
import type { DiffFilesResult } from "../../services/tauri";
import type { DiffFile, StagedDiffFiles } from "../../types/diff";
import type { Workspace } from "../../types";
import { RightSidebar } from "./RightSidebar";

const serviceMocks = vi.hoisted(() => ({
  discardFile: vi.fn(),
  discardFiles: vi.fn(),
  loadDiffFiles: vi.fn(),
  sendRemoteCommand: vi.fn(),
  stageFile: vi.fn(),
  stageFiles: vi.fn(),
  unstageFile: vi.fn(),
  unstageFiles: vi.fn(),
}));

vi.mock("../../services/tauri", () => ({
  discardFile: serviceMocks.discardFile,
  discardFiles: serviceMocks.discardFiles,
  loadDiffFiles: serviceMocks.loadDiffFiles,
  sendRemoteCommand: serviceMocks.sendRemoteCommand,
  stageFile: serviceMocks.stageFile,
  stageFiles: serviceMocks.stageFiles,
  unstageFile: serviceMocks.unstageFile,
  unstageFiles: serviceMocks.unstageFiles,
}));

vi.mock("../../hooks/useWorkspaceTaskHistory", () => ({
  useWorkspaceTaskHistory: () => ({
    totalBadgeCount: 0,
    current: { tasks: [] },
    subagents: [],
  }),
}));

vi.mock("../files/FilesPanel", () => ({
  FilesPanel: () => null,
}));

vi.mock("./PrStatusBanner", () => ({
  PrStatusBanner: () => null,
}));

vi.mock("./TaskList", () => ({
  TaskList: () => null,
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

function diffResult(path: string): DiffFilesResult {
  const file: DiffFile = { path, status: "Modified" };
  const staged_files: StagedDiffFiles = {
    committed: [],
    staged: [],
    unstaged: [file],
    untracked: [],
  };
  return {
    files: [file],
    merge_base: "abc123",
    staged_files,
    commits: [],
  };
}

const roots: Root[] = [];
const containers: HTMLElement[] = [];

async function renderSidebar(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    root.render(<RightSidebar />);
  });
  return container;
}

beforeEach(() => {
  serviceMocks.loadDiffFiles.mockReset();
  useAppStore.setState({
    selectedWorkspaceId: "changes-cache-ws-a",
    workspaces: [
      makeWorkspace("changes-cache-ws-a"),
      makeWorkspace("changes-cache-ws-b"),
    ],
    rightSidebarTabByWorkspace: {
      "changes-cache-ws-a": "changes",
      "changes-cache-ws-b": "changes",
    },
    fileTreeRefreshNonceByWorkspace: {},
    diffFiles: [],
    diffMergeBase: null,
    diffStagedFiles: null,
    diffLoading: false,
    commitHistory: null,
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await act(async () => root.unmount());
  }
  for (const container of containers.splice(0)) container.remove();
});

describe("RightSidebar changes cache", () => {
  it("renders cached changes immediately when switching back to a workspace", async () => {
    const firstA = deferred<DiffFilesResult>();
    const firstB = deferred<DiffFilesResult>();
    const secondA = deferred<DiffFilesResult>();
    const loads = new Map<string, Deferred<DiffFilesResult>[]>([
      ["changes-cache-ws-a", [firstA, secondA]],
      ["changes-cache-ws-b", [firstB]],
    ]);
    serviceMocks.loadDiffFiles.mockImplementation((workspaceId: string) => {
      const next = loads.get(workspaceId)?.shift();
      if (!next) throw new Error(`unexpected load for ${workspaceId}`);
      return next.promise;
    });

    const container = await renderSidebar();
    expect(container.textContent).toContain("Loading");

    await act(async () => {
      firstA.resolve(diffResult("src/a.ts"));
      await firstA.promise;
    });
    expect(container.textContent).toContain("src/a.ts");

    await act(async () => {
      useAppStore.setState({ selectedWorkspaceId: "changes-cache-ws-b" });
    });
    expect(container.textContent).toContain("Loading");

    await act(async () => {
      firstB.resolve(diffResult("src/b.ts"));
      await firstB.promise;
    });
    expect(container.textContent).toContain("src/b.ts");

    await act(async () => {
      useAppStore.setState({ selectedWorkspaceId: "changes-cache-ws-a" });
    });
    expect(container.textContent).toContain("src/a.ts");
    expect(container.textContent).not.toContain("Loading");

    await act(async () => {
      secondA.resolve(diffResult("src/a-new.ts"));
      await secondA.promise;
    });
    expect(container.textContent).toContain("src/a-new.ts");
  });

  it("invalidates cached changes when the workspace refresh nonce changes", async () => {
    const first = deferred<DiffFilesResult>();
    const refreshed = deferred<DiffFilesResult>();
    serviceMocks.loadDiffFiles
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(refreshed.promise);

    const container = await renderSidebar();
    await act(async () => {
      first.resolve(diffResult("src/original.ts"));
      await first.promise;
    });

    await act(async () => {
      useAppStore.setState({
        fileTreeRefreshNonceByWorkspace: { "changes-cache-ws-a": 1 },
      });
    });
    expect(container.textContent).toContain("Loading");
    expect(container.textContent).not.toContain("src/original.ts");

    await act(async () => {
      refreshed.resolve(diffResult("src/refreshed.ts"));
      await refreshed.promise;
    });
    expect(container.textContent).toContain("src/refreshed.ts");
  });
});
