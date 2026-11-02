// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/useAppStore";
import type { ChatSession } from "../../types/chat";
import type { DiffFileTab } from "../../types/diff";
import {
  archiveChatSession,
  createChatSession,
  listChatSessions,
} from "../../services/tauri";
import { ask } from "@tauri-apps/plugin-dialog";
import { SessionTabs } from "./SessionTabs";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../services/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tauri")>();
  return {
    ...actual,
    listChatSessions: vi.fn(),
    createChatSession: vi.fn(),
    archiveChatSession: vi.fn(),
    renameChatSession: vi.fn(),
    reorderChatSessions: vi.fn(),
    readWorkspaceFileForViewer: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.name ? `${key}:${String(values.name)}` : key,
  }),
}));

const WORKSPACE_ID = "workspace-1";

const listChatSessionsMock = vi.mocked(listChatSessions);
const createChatSessionMock = vi.mocked(createChatSession);
const archiveChatSessionMock = vi.mocked(archiveChatSession);
const askMock = vi.mocked(ask);

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function makeSession(
  id: string,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    session_id: null,
    name: `Chat ${id}`,
    name_edited: false,
    turn_count: 3,
    sort_order: 0,
    status: "Active",
    created_at: "2026-05-01T00:00:00Z",
    archived_at: null,
    cli_invocation: null,
    agent_status: "Stopped",
    needs_attention: false,
    attention_kind: null,
    ...overrides,
  };
}

const DIFF_TAB: DiffFileTab = { path: "src/lib/diffed.ts", layer: null };
const FILE_PATH = "src/app/opened.ts";

function seedStore(sessions: ChatSession[], selectedId: string) {
  useAppStore.setState({
    workspaces: [],
    sessionsByWorkspace: { [WORKSPACE_ID]: sessions },
    selectedSessionIdByWorkspaceId: { [WORKSPACE_ID]: selectedId },
    diffTabsByWorkspace: { [WORKSPACE_ID]: [DIFF_TAB] },
    diffSelectedFile: null,
    diffSelectedLayer: null,
    diffStagedFiles: null,
    fileTabsByWorkspace: { [WORKSPACE_ID]: [FILE_PATH] },
    activeFileTabByWorkspace: {},
    tabOrderByWorkspace: {},
    fileBuffers: {},
    chatDrafts: {},
    pendingAttachmentsBySession: {},
  });
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderTabs(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<SessionTabs workspaceId={WORKSPACE_ID} />);
  });
  await flushEffects();
  return container;
}

function tabs(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
}

async function keyDown(el: HTMLElement, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushEffects();
}

describe("SessionTabs", () => {
  const sessionA = makeSession("a");
  const sessionB = makeSession("b");

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    listChatSessionsMock.mockResolvedValue([sessionA, sessionB]);
    archiveChatSessionMock.mockResolvedValue(null);
    seedStore([sessionA, sessionB], "a");
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

  it("renders sessions, diffs, and files as tabs in unified order", async () => {
    const container = await renderTabs();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    const all = tabs(container);
    expect(all.map((t) => t.textContent)).toEqual([
      "Chat a",
      "Chat b",
      "diffed.ts",
      "opened.ts",
    ]);
    expect(all.map((t) => t.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(all.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(all.map((t) => t.dataset.sessionTabKey)).toHaveLength(4);
    expect(all.every((t) => t.dataset.sessionTabKey)).toBe(true);
    // Close buttons carry kind-specific aria labels.
    const closeLabels = all.map((t) =>
      t.querySelector("button[aria-label^='session_close']")?.getAttribute("aria-label"),
    );
    expect(closeLabels).toEqual([
      "session_close",
      "session_close",
      "session_close_diff",
      "session_close_file",
    ]);
  });

  it("navigates between tabs with arrow keys, Home, and End", async () => {
    const container = await renderTabs();
    await keyDown(tabs(container)[0], "ArrowRight");
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId[WORKSPACE_ID]).toBe("b");
    expect(document.activeElement).toBe(tabs(container)[1]);

    await keyDown(tabs(container)[1], "ArrowRight");
    expect(useAppStore.getState().diffSelectedFile).toBe(DIFF_TAB.path);
    expect(tabs(container)[2].getAttribute("aria-selected")).toBe("true");

    await keyDown(tabs(container)[2], "End");
    expect(useAppStore.getState().activeFileTabByWorkspace[WORKSPACE_ID]).toBe(FILE_PATH);
    expect(tabs(container)[3].getAttribute("aria-selected")).toBe("true");

    await keyDown(tabs(container)[3], "ArrowRight");
    // Wraps back to the first tab and clears the file selection.
    expect(useAppStore.getState().activeFileTabByWorkspace[WORKSPACE_ID] ?? null).toBeNull();
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId[WORKSPACE_ID]).toBe("a");

    await keyDown(tabs(container)[0], "ArrowLeft");
    expect(useAppStore.getState().activeFileTabByWorkspace[WORKSPACE_ID]).toBe(FILE_PATH);

    await keyDown(tabs(container)[3], "Home");
    expect(useAppStore.getState().activeFileTabByWorkspace[WORKSPACE_ID] ?? null).toBeNull();
    expect(tabs(container)[0].getAttribute("aria-selected")).toBe("true");
  });

  it("selects a tab on click and Enter", async () => {
    const container = await renderTabs();
    await click(tabs(container)[2]);
    expect(useAppStore.getState().diffSelectedFile).toBe(DIFF_TAB.path);
    await keyDown(tabs(container)[1], "Enter");
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId[WORKSPACE_ID]).toBe("b");
  });

  it("archives an inactive session without confirmation", async () => {
    const container = await renderTabs();
    const closeBtn = tabs(container)[1].querySelector("button")!;
    await click(closeBtn);
    expect(askMock).not.toHaveBeenCalled();
    expect(archiveChatSessionMock).toHaveBeenCalledWith("b", true);
    // The click on close must not also select the tab.
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId[WORKSPACE_ID]).toBe("a");
    expect(tabs(container).map((t) => t.textContent)).toEqual([
      "Chat a",
      "diffed.ts",
      "opened.ts",
    ]);
  });

  it("confirms before archiving the active session and respects cancel", async () => {
    askMock.mockResolvedValue(false);
    const container = await renderTabs();
    await click(tabs(container)[0].querySelector("button")!);
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(askMock.mock.calls[0][0]).toBe("session_active_confirm_close:Chat a");
    expect(archiveChatSessionMock).not.toHaveBeenCalled();
  });

  it("closes diff and clean file tabs via their close buttons", async () => {
    const container = await renderTabs();
    await click(tabs(container)[2].querySelector("button")!);
    expect(useAppStore.getState().diffTabsByWorkspace[WORKSPACE_ID]).toEqual([]);
    const fileTab = tabs(container).find((t) => t.textContent === "opened.ts")!;
    await click(fileTab.querySelector("button[aria-label='session_close_file']")!);
    expect(useAppStore.getState().fileTabsByWorkspace[WORKSPACE_ID]).toEqual([]);
    expect(archiveChatSessionMock).not.toHaveBeenCalled();
  });

  it("opens the context menu and closes other tabs", async () => {
    const container = await renderTabs();
    await act(async () => {
      tabs(container)[2].dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
      );
    });
    const labels = Array.from(document.body.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(
      expect.arrayContaining([
        "tab_close",
        "tab_close_others",
        "tab_close_to_right",
        "tab_close_all",
      ]),
    );
  });

  it("creates a new session from the add button", async () => {
    const created = makeSession("c", { turn_count: 0 });
    createChatSessionMock.mockResolvedValue(created);
    const container = await renderTabs();
    await click(container.querySelector("button[aria-label='session_new']")!);
    expect(createChatSessionMock).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId[WORKSPACE_ID]).toBe("c");
    expect(tabs(container).map((t) => t.textContent)).toContain("Chat c");
  });
});
