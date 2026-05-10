// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  sidebarVisible: true,
  sidebarWidth: 260,
  setSidebarWidth: vi.fn(),
  rightSidebarVisible: true,
  rightSidebarWidth: 320,
  setRightSidebarWidth: vi.fn(),
  selectedWorkspaceId: null as string | null,
  diffSelectedFile: null as string | null,
  terminalPanelVisible: false,
  terminalHeight: 300,
  setTerminalHeight: vi.fn(),
  settingsOpen: false,
  fuzzyFinderOpen: false,
  commandPaletteOpen: false,
}));

vi.mock("../../stores/useAppStore", () => ({
  selectActiveFileTabPath: () => null,
  useAppStore: <T,>(selector: (state: typeof store) => T): T => selector(store),
}));

vi.mock("../sidebar/Sidebar", () => ({ Sidebar: () => <div /> }));
vi.mock("../chat/ChatPanel", () => ({ ChatPanel: () => <div /> }));
vi.mock("../diff/DiffViewer", () => ({ DiffViewer: () => <div /> }));
vi.mock("../file-viewer/FileViewer", () => ({ FileViewer: () => <div /> }));
vi.mock("../terminal/TerminalPanel", () => ({
  TerminalPanel: () => <div data-testid="terminal-panel" />,
}));
vi.mock("../right-sidebar/RightSidebar", () => ({ RightSidebar: () => <div /> }));
vi.mock("../fuzzy-finder/FuzzyFinder", () => ({ FuzzyFinder: () => <div /> }));
vi.mock("../command-palette/CommandPalette", () => ({ CommandPalette: () => <div /> }));
vi.mock("./Dashboard", () => ({ Dashboard: () => <div /> }));
vi.mock("../modals/ModalRouter", () => ({ ModalRouter: () => <div /> }));
vi.mock("../settings/SettingsPage", () => ({ SettingsPage: () => <div /> }));
vi.mock("./ResizeHandle", () => ({ ResizeHandle: () => <div /> }));
vi.mock("./Toast", () => ({ ToastContainer: () => <div /> }));
vi.mock("../shared/AppTooltip", () => ({ AppTooltip: () => <div /> }));
vi.mock("../../hooks/useAgentStream", () => ({ useAgentStream: vi.fn() }));
vi.mock("../../hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock("../../hooks/useBranchRefresh", () => ({ useBranchRefresh: vi.fn() }));
vi.mock("../../hooks/useAutoUpdater", () => ({ useAutoUpdater: vi.fn() }));
vi.mock("../../hooks/useWorkspaceFileWatcher", () => ({ useWorkspaceFileWatcher: vi.fn() }));
vi.mock("../../hooks/useWorkspaceEnvironmentPreparation", () => ({
  useWorkspaceEnvironmentPreparation: vi.fn(),
}));

import { AppLayout } from "./AppLayout";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function renderAppLayout() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<AppLayout />);
  });
  return container;
}

describe("AppLayout terminal owner", () => {
  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
    for (const container of mountedContainers.splice(0)) {
      container.remove();
    }
    store.selectedWorkspaceId = null;
    store.terminalPanelVisible = false;
  });

  it("keeps TerminalPanel mounted when no workspace is selected", async () => {
    const container = await renderAppLayout();

    expect(container.querySelector('[data-testid="terminal-panel"]')).not.toBeNull();
  });
});
