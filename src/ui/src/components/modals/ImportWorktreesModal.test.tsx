// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../stores/useAppStore";
import type { DiscoveredWorktree } from "../../services/tauri";
import type { BackendWorkspace } from "../../types";
import { ImportWorktreesModal } from "./ImportWorktreesModal";

const serviceMocks = vi.hoisted(() => ({
  discoverWorktrees: vi.fn(),
  importWorktrees: vi.fn(),
  purgeStrayWorktree: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../services/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tauri")>();
  return { ...actual, ...serviceMocks };
});

const REPO_ID = "repo-1";

const discovered: DiscoveredWorktree = {
  path: "/tmp/repo-1-feature",
  branch_name: "feature",
  head_sha: "abc123",
  suggested_name: "feature",
  name_valid: true,
  size_bytes: null,
};

// Shaped like the real IPC payload: the Rust `Workspace` model has no
// `remote_connection_id`, so the key is absent, not `null`.
const importedRow: BackendWorkspace = {
  id: "ws-imported",
  repository_id: REPO_ID,
  name: "feature",
  branch_name: "feature",
  worktree_path: "/tmp/repo-1-feature",
  status: "Active",
  agent_status: "Idle",
  status_line: "",
  created_at: "2026-11-23T00:00:00Z",
  sort_order: 0,
  input_values: null,
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ImportWorktreesModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    serviceMocks.discoverWorktrees.mockResolvedValue([discovered]);
    serviceMocks.importWorktrees.mockResolvedValue([importedRow]);
    useAppStore.setState({
      workspaces: [],
      activeModal: "importWorktrees",
      modalData: { repoId: REPO_ID },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("stamps imported workspaces as local so env preparation can start", async () => {
    await act(async () => {
      root.render(<ImportWorktreesModal />);
    });
    await flush();

    const importButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "import_worktrees_confirm_singular");
    expect(importButton).toBeDefined();

    await act(async () => {
      importButton!.click();
    });
    await flush();

    expect(serviceMocks.importWorktrees).toHaveBeenCalledWith(REPO_ID, [
      { path: discovered.path, branch_name: "feature", name: "feature" },
    ]);
    const stored = useAppStore
      .getState()
      .workspaces.find((w) => w.id === importedRow.id);
    expect(stored).toBeDefined();
    // `undefined` here makes useWorkspaceEnvironmentPreparation bail as
    // "not hydrated yet", stranding the chat on "Preparing workspace
    // environment…" with no timeout (issue 1036).
    expect(stored!.remote_connection_id).toBeNull();
  });
});
