// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/useAppStore";
import type { ChatSession } from "../../types/chat";
import type { Repository } from "../../types/repository";
import type { Workspace } from "../../types/workspace";
import {
  createChatSession,
  listChatSessions,
  restoreChatSession,
} from "../../services/tauri";
import { createWorkspaceOrchestrated } from "../../hooks/useCreateWorkspace";
import { WorkspaceEmptyTabs } from "./WorkspaceEmptyTabs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../services/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tauri")>();
  return {
    ...actual,
    createChatSession: vi.fn(),
    listChatSessions: vi.fn(),
    restoreChatSession: vi.fn(),
  };
});

vi.mock("../../hooks/useCreateWorkspace", () => ({
  createWorkspaceOrchestrated: vi.fn(),
}));

const WORKSPACE_ID = "workspace-1";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

const createChatSessionMock = vi.mocked(createChatSession);
const listChatSessionsMock = vi.mocked(listChatSessions);
const restoreChatSessionMock = vi.mocked(restoreChatSession);
const createWorkspaceOrchestratedMock = vi.mocked(createWorkspaceOrchestrated);

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: WORKSPACE_ID,
    repository_id: "repo-1",
    name: "Refactor Kitchen",
    branch_name: "chore/tidy-tabs",
    worktree_path: "/tmp/refactor-kitchen",
    status: "Active",
    agent_status: "Stopped",
    status_line: "",
    created_at: "2026-05-09T12:00:00Z",
    sort_order: 0,
    remote_connection_id: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-1",
    path: "/Users/me/code/refactor-kitchen",
    name: "refactor-kitchen",
    path_slug: "refactor-kitchen",
    icon: null,
    created_at: "2026-05-01T00:00:00Z",
    setup_script: null,
    custom_instructions: null,
    sort_order: 0,
    branch_rename_preferences: null,
    setup_script_auto_run: false,
    archive_script: null,
    archive_script_auto_run: false,
    base_branch: null,
    default_remote: null,
    path_valid: true,
    remote_connection_id: null,
    ...overrides,
  };
}

function makeSession(
  id: string,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    session_id: null,
    name: id,
    name_edited: false,
    turn_count: 1,
    sort_order: 0,
    status: "Archived",
    created_at: "2026-05-01T00:00:00Z",
    archived_at: "2026-05-01T01:00:00Z",
    cli_invocation: null,
    agent_status: "Stopped",
    needs_attention: false,
    attention_kind: null,
    ...overrides,
  };
}

function resetStore() {
  useAppStore.setState({
    selectedWorkspaceId: WORKSPACE_ID,
    sessionsByWorkspace: {},
    selectedSessionIdByWorkspaceId: {},
    activeFileTabByWorkspace: {},
    fileTabsByWorkspace: {},
    diffSelectedFile: null,
    diffSelectedLayer: null,
    rightSidebarVisible: false,
    rightSidebarTab: "files",
    requestNewFileNonceByWorkspace: {},
  });
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderEmptyTabs(
  props: {
    workspace?: Workspace;
    repository?: Repository | undefined;
  } = {},
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(
      <WorkspaceEmptyTabs
        workspace={props.workspace ?? makeWorkspace()}
        repository={
          props.repository === undefined ? makeRepo() : props.repository
        }
      />,
    );
  });
  await flushEffects();
  return container;
}

describe("WorkspaceEmptyTabs", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    resetStore();
    listChatSessionsMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    for (const root of mountedRoots.splice(0).reverse()) {
      await act(async () => {
        root.unmount();
      });
    }
    for (const container of mountedContainers.splice(0)) {
      container.remove();
    }
  });

  it("renders the workspace name in the empty-tabs title", async () => {
    const container = await renderEmptyTabs({
      workspace: makeWorkspace({ name: "Polish Sidebar" }),
    });

    expect(container.querySelector("h1")?.textContent).toBe(
      "Pick up Polish Sidebar.",
    );
  });

  it("shows only resumable archived sessions sorted by archive time descending", async () => {
    listChatSessionsMock.mockResolvedValue([
      makeSession("empty-placeholder", {
        name: "Empty placeholder",
        turn_count: 0,
        archived_at: "2026-05-12T10:00:00Z",
      }),
      makeSession("active-session", {
        name: "Active session",
        status: "Active",
        archived_at: null,
      }),
      makeSession("older", {
        name: "Older work",
        archived_at: "2026-05-10T10:00:00Z",
      }),
      makeSession("newer", {
        name: "Newer work",
        archived_at: "2026-05-12T09:00:00Z",
      }),
      makeSession("created-fallback", {
        name: "Created fallback",
        created_at: "2026-05-11T11:00:00Z",
        archived_at: null,
      }),
    ]);

    const container = await renderEmptyTabs();

    const resumeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[title^='Resume ']"),
    );
    expect(resumeButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Newer work"),
      expect.stringContaining("Created fallback"),
      expect.stringContaining("Older work"),
    ]);
    expect(container.textContent).not.toContain("Empty placeholder");
    expect(container.textContent).not.toContain("Active session");
  });

  it("restores and selects an archived session when its row is clicked", async () => {
    const archived = makeSession("archived-1", { name: "Resume me" });
    const restored = makeSession("archived-1", {
      name: "Resume me",
      status: "Active",
      archived_at: null,
    });
    listChatSessionsMock.mockResolvedValue([archived]);
    restoreChatSessionMock.mockResolvedValue(restored);
    const container = await renderEmptyTabs();

    const resumeButton = container.querySelector<HTMLButtonElement>(
      "button[title='Resume Resume me']",
    );
    expect(resumeButton).toBeTruthy();
    await act(async () => {
      resumeButton!.click();
    });
    await flushEffects();

    expect(restoreChatSessionMock).toHaveBeenCalledWith("archived-1");
    const state = useAppStore.getState();
    expect(state.sessionsByWorkspace[WORKSPACE_ID]?.map((s) => s.id)).toEqual([
      "archived-1",
    ]);
    expect(state.selectedSessionIdByWorkspaceId[WORKSPACE_ID]).toBe(
      "archived-1",
    );
  });

  it("creates an in-workspace chat session from the New Session CTA", async () => {
    const created = makeSession("new-session", {
      status: "Active",
      archived_at: null,
    });
    createChatSessionMock.mockResolvedValue(created);
    const container = await renderEmptyTabs();

    const newSessionButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("New Session"));
    expect(newSessionButton).toBeTruthy();

    await act(async () => {
      newSessionButton!.click();
    });
    await flushEffects();

    expect(createChatSessionMock).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(createWorkspaceOrchestratedMock).not.toHaveBeenCalled();
    const state = useAppStore.getState();
    expect(state.sessionsByWorkspace[WORKSPACE_ID]?.map((s) => s.id)).toEqual([
      "new-session",
    ]);
    expect(state.selectedSessionIdByWorkspaceId[WORKSPACE_ID]).toBe(
      "new-session",
    );
  });
});
