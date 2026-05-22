// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  shouldDeferSettingsEscapeForElement,
  useKeyboardShortcuts,
} from "./useKeyboardShortcuts";
import { useAppStore } from "../stores/useAppStore";
import type { ScmSummary } from "../types/plugin";
import type { Workspace } from "../types/workspace";
import type { Repository } from "../types";

function Harness() {
  useKeyboardShortcuts();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderHarness() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Harness));
  });
}

async function pressEscape() {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

async function pressQuickOpenHotkey() {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "p",
        ctrlKey: true,
        bubbles: true,
      }),
    );
  });
}

describe("shouldDeferSettingsEscapeForElement", () => {
  it("keeps Settings Escape local to focused native fields", () => {
    expect(shouldDeferSettingsEscapeForElement(document.createElement("input")))
      .toBe(true);
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    expect(shouldDeferSettingsEscapeForElement(searchInput)).toBe(true);
    const numberInput = document.createElement("input");
    numberInput.type = "number";
    expect(shouldDeferSettingsEscapeForElement(numberInput)).toBe(true);
    expect(shouldDeferSettingsEscapeForElement(document.createElement("textarea")))
      .toBe(true);
    expect(shouldDeferSettingsEscapeForElement(document.createElement("select")))
      .toBe(true);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(shouldDeferSettingsEscapeForElement(checkbox)).toBe(false);
    const radio = document.createElement("input");
    radio.type = "radio";
    expect(shouldDeferSettingsEscapeForElement(radio)).toBe(false);
    expect(shouldDeferSettingsEscapeForElement(document.createElement("button")))
      .toBe(false);
    expect(shouldDeferSettingsEscapeForElement(null)).toBe(false);
  });
});

describe("useKeyboardShortcuts Settings Escape", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    useAppStore.setState({
      activeModal: null,
      commandPaletteOpen: false,
      fuzzyFinderOpen: false,
      settingsOpen: true,
      settingsOverlayCount: 0,
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    container = null;
    document.body.innerHTML = "";
    useAppStore.setState({
      settingsOpen: false,
      settingsOverlayCount: 0,
    });
  });

  it("blurs a focused Settings text input before closing Settings", async () => {
    await renderHarness();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    await pressEscape();
    expect(document.activeElement).not.toBe(input);
    expect(useAppStore.getState().settingsOpen).toBe(true);

    await pressEscape();
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });
});
describe("useKeyboardShortcuts command palette quick-open toggle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    useAppStore.setState({
      activeModal: null,
      commandPaletteOpen: true,
      commandPaletteInitialMode: null,
      fuzzyFinderOpen: false,
      selectedWorkspaceId: "ws-1",
      settingsOpen: false,
      settingsOverlayCount: 0,
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    container = null;
    document.body.innerHTML = "";
    useAppStore.setState({
      commandPaletteOpen: false,
      commandPaletteInitialMode: null,
      selectedWorkspaceId: null,
    });
  });

  it("dismisses the command palette when the quick-open hotkey is pressed again", async () => {
    await renderHarness();

    await pressQuickOpenHotkey();

    expect(useAppStore.getState().commandPaletteOpen).toBe(false);
    expect(useAppStore.getState().commandPaletteInitialMode).toBeNull();
  });
});

function makeWorkspace(
  id: string,
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    repository_id: "repo-1",
    name: id,
    branch_name: id,
    worktree_path: `/tmp/${id}`,
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "2026-01-01T00:00:00Z",
    sort_order: 0,
    remote_connection_id: null,
    input_values: null,
    ...overrides,
  };
}

function makeRepo(id: string, sort_order = 0): Repository {
  return {
    id,
    path: `/tmp/${id}`,
    name: id,
    path_slug: id,
    icon: null,
    created_at: "2026-01-01T00:00:00Z",
    setup_script: null,
    custom_instructions: null,
    sort_order,
    branch_rename_preferences: null,
    setup_script_auto_run: false,
    archive_script: null,
    archive_script_auto_run: false,
    base_branch: null,
    default_remote: null,
    path_valid: true,
    remote_connection_id: null,
    required_inputs: null,
  };
}

function summary(prState: ScmSummary["prState"], hasPr = true): ScmSummary {
  return { hasPr, prState, ciState: null, lastUpdated: 0 };
}

async function pressJumpKey(digit: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: String(digit),
        // happy-dom navigator.platform is empty → hotkey platform resolves to
        // "linux" so `mod` matches `ctrlKey`.
        ctrlKey: true,
        bubbles: true,
      }),
    );
  });
}

describe("useKeyboardShortcuts jump-to-project / workspace", () => {
  let selectWorkspaceSpy: ReturnType<typeof vi.fn<(id: string | null) => void>>;
  let selectRepositorySpy: ReturnType<typeof vi.fn<(id: string | null) => void>>;

  beforeEach(() => {
    document.body.innerHTML = "";
    selectWorkspaceSpy = vi.fn<(id: string | null) => void>();
    selectRepositorySpy = vi.fn<(id: string | null) => void>();
    useAppStore.setState({
      activeModal: null,
      commandPaletteOpen: false,
      fuzzyFinderOpen: false,
      settingsOpen: false,
      settingsOverlayCount: 0,
      sidebarRepoFilter: "all",
      sidebarShowArchived: false,
      statusGroupCollapsed: {},
      scmSummary: {},
      selectWorkspace: selectWorkspaceSpy,
      selectRepository: selectRepositorySpy,
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    container = null;
    document.body.innerHTML = "";
  });

  it("repo mode: Cmd+N jumps to the Nth project's active workspace", async () => {
    useAppStore.setState({
      sidebarGroupBy: "repo",
      repositories: [makeRepo("repo-a"), makeRepo("repo-b"), makeRepo("repo-c")],
      workspaces: [
        makeWorkspace("ws-a", { repository_id: "repo-a" }),
        makeWorkspace("ws-b", { repository_id: "repo-b" }),
        makeWorkspace("ws-c", { repository_id: "repo-c" }),
      ],
    });
    await renderHarness();

    await pressJumpKey(2);
    expect(selectWorkspaceSpy).toHaveBeenCalledWith("ws-b");
    expect(selectRepositorySpy).not.toHaveBeenCalled();
  });

  it("repo mode: Cmd+N opens project-scoped view when the project has no active workspace", async () => {
    useAppStore.setState({
      sidebarGroupBy: "repo",
      repositories: [makeRepo("repo-empty")],
      workspaces: [],
    });
    await renderHarness();

    await pressJumpKey(1);
    expect(selectRepositorySpy).toHaveBeenCalledWith("repo-empty");
    expect(selectWorkspaceSpy).not.toHaveBeenCalled();
  });

  it("status mode: Cmd+N jumps to the Nth visible workspace, not the Nth project", async () => {
    // Buckets render top-to-bottom in STATUS_BUCKET_ORDER: merged, in-review,
    // draft, in-progress, closed, archived. We give the third project's
    // workspace the merged status so it lands at position 1 — confirming
    // status mode indexes by visible row, not by project.
    useAppStore.setState({
      sidebarGroupBy: "status",
      repositories: [makeRepo("repo-a"), makeRepo("repo-b"), makeRepo("repo-c")],
      workspaces: [
        makeWorkspace("ws-a", { repository_id: "repo-a" }),
        makeWorkspace("ws-b", { repository_id: "repo-b" }),
        makeWorkspace("ws-c", { repository_id: "repo-c" }),
      ],
      scmSummary: {
        "ws-c": summary("merged"),
        "ws-a": summary("open"),
        "ws-b": summary(null, false),
      },
    });
    await renderHarness();

    await pressJumpKey(1);
    expect(selectWorkspaceSpy).toHaveBeenCalledWith("ws-c");

    selectWorkspaceSpy.mockClear();
    await pressJumpKey(2);
    expect(selectWorkspaceSpy).toHaveBeenCalledWith("ws-a");

    selectWorkspaceSpy.mockClear();
    await pressJumpKey(3);
    expect(selectWorkspaceSpy).toHaveBeenCalledWith("ws-b");
  });

  it("status mode: skips workspaces in collapsed buckets", async () => {
    useAppStore.setState({
      sidebarGroupBy: "status",
      repositories: [makeRepo("repo-a")],
      workspaces: [
        makeWorkspace("ws-merged", { repository_id: "repo-a" }),
        makeWorkspace("ws-in-progress", { repository_id: "repo-a" }),
      ],
      scmSummary: {
        "ws-merged": summary("merged"),
        "ws-in-progress": summary(null, false),
      },
      // Collapse the merged bucket — Cmd+1 should now target the
      // first visible row, which is "ws-in-progress".
      statusGroupCollapsed: { "status:merged": true },
    });
    await renderHarness();

    await pressJumpKey(1);
    expect(selectWorkspaceSpy).toHaveBeenCalledWith("ws-in-progress");
  });

  it("status mode: out-of-range N is a no-op", async () => {
    useAppStore.setState({
      sidebarGroupBy: "status",
      repositories: [makeRepo("repo-a")],
      workspaces: [makeWorkspace("ws-a", { repository_id: "repo-a" })],
      scmSummary: { "ws-a": summary(null, false) },
    });
    await renderHarness();

    await pressJumpKey(5);
    expect(selectWorkspaceSpy).not.toHaveBeenCalled();
    expect(selectRepositorySpy).not.toHaveBeenCalled();
  });
});
