import { create } from "zustand";
import type {
  Repository,
  Workspace,
  ChatMessage,
  DiffFile,
  FileDiff,
  DiffViewMode,
  TerminalTab,
} from "../types";

export interface ToolActivity {
  toolUseId: string;
  toolName: string;
  inputJson: string;
  resultText: string;
  collapsed: boolean;
}

interface AppState {
  // -- Repositories --
  repositories: Repository[];
  setRepositories: (repos: Repository[]) => void;
  addRepository: (repo: Repository) => void;
  updateRepository: (id: string, updates: Partial<Repository>) => void;
  removeRepository: (id: string) => void;

  // -- Workspaces --
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (ws: Workspace) => void;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  removeWorkspace: (id: string) => void;
  selectWorkspace: (id: string | null) => void;

  // -- Chat --
  chatMessages: Record<string, ChatMessage[]>;
  chatInput: string;
  streamingContent: Record<string, string>;
  toolActivities: Record<string, ToolActivity[]>;
  setChatMessages: (wsId: string, messages: ChatMessage[]) => void;
  addChatMessage: (wsId: string, message: ChatMessage) => void;
  setChatInput: (input: string) => void;
  setStreamingContent: (wsId: string, content: string) => void;
  appendStreamingContent: (wsId: string, text: string) => void;
  setToolActivities: (wsId: string, activities: ToolActivity[]) => void;
  addToolActivity: (wsId: string, activity: ToolActivity) => void;
  updateToolActivity: (
    wsId: string,
    toolUseId: string,
    updates: Partial<ToolActivity>
  ) => void;
  toggleToolActivityCollapsed: (wsId: string, index: number) => void;

  // -- Diff --
  diffFiles: DiffFile[];
  diffMergeBase: string | null;
  diffSelectedFile: string | null;
  diffContent: FileDiff | null;
  diffViewMode: DiffViewMode;
  diffLoading: boolean;
  diffError: string | null;
  setDiffFiles: (files: DiffFile[], mergeBase: string) => void;
  setDiffSelectedFile: (path: string | null) => void;
  setDiffContent: (content: FileDiff | null) => void;
  setDiffViewMode: (mode: DiffViewMode) => void;
  setDiffLoading: (loading: boolean) => void;
  setDiffError: (error: string | null) => void;
  clearDiff: () => void;

  // -- Terminal --
  terminalTabs: Record<string, TerminalTab[]>;
  activeTerminalTabId: number | null;
  terminalPanelVisible: boolean;
  setTerminalTabs: (wsId: string, tabs: TerminalTab[]) => void;
  addTerminalTab: (wsId: string, tab: TerminalTab) => void;
  removeTerminalTab: (wsId: string, tabId: number) => void;
  setActiveTerminalTab: (id: number | null) => void;
  toggleTerminalPanel: () => void;

  // -- UI --
  sidebarVisible: boolean;
  rightSidebarVisible: boolean;
  sidebarWidth: number;
  rightSidebarWidth: number;
  terminalHeight: number;
  sidebarFilter: "all" | "active" | "archived";
  repoCollapsed: Record<string, boolean>;
  fuzzyFinderOpen: boolean;
  toggleSidebar: () => void;
  toggleRightSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setRightSidebarWidth: (w: number) => void;
  setTerminalHeight: (h: number) => void;
  setSidebarFilter: (f: "all" | "active" | "archived") => void;
  toggleRepoCollapsed: (id: string) => void;
  toggleFuzzyFinder: () => void;

  // -- Modals --
  activeModal: string | null;
  modalData: Record<string, unknown>;
  openModal: (name: string, data?: Record<string, unknown>) => void;
  closeModal: () => void;

  // -- Settings --
  worktreeBaseDir: string;
  setWorktreeBaseDir: (dir: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // -- Repositories --
  repositories: [],
  setRepositories: (repos) => set({ repositories: repos }),
  addRepository: (repo) =>
    set((s) => ({ repositories: [...s.repositories, repo] })),
  updateRepository: (id, updates) =>
    set((s) => ({
      repositories: s.repositories.map((r) =>
        r.id === id ? { ...r, ...updates } : r
      ),
    })),
  removeRepository: (id) =>
    set((s) => ({
      repositories: s.repositories.filter((r) => r.id !== id),
      workspaces: s.workspaces.filter((w) => w.repository_id !== id),
    })),

  // -- Workspaces --
  workspaces: [],
  selectedWorkspaceId: null,
  setWorkspaces: (workspaces) => set({ workspaces }),
  addWorkspace: (ws) =>
    set((s) => ({ workspaces: [...s.workspaces, ws] })),
  updateWorkspace: (id, updates) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, ...updates } : w
      ),
    })),
  removeWorkspace: (id) =>
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
      selectedWorkspaceId:
        s.selectedWorkspaceId === id ? null : s.selectedWorkspaceId,
    })),
  selectWorkspace: (id) => set({ selectedWorkspaceId: id }),

  // -- Chat --
  chatMessages: {},
  chatInput: "",
  streamingContent: {},
  toolActivities: {},
  setChatMessages: (wsId, messages) =>
    set((s) => ({
      chatMessages: { ...s.chatMessages, [wsId]: messages },
    })),
  addChatMessage: (wsId, message) =>
    set((s) => ({
      chatMessages: {
        ...s.chatMessages,
        [wsId]: [...(s.chatMessages[wsId] || []), message],
      },
    })),
  setChatInput: (input) => set({ chatInput: input }),
  setStreamingContent: (wsId, content) =>
    set((s) => ({
      streamingContent: { ...s.streamingContent, [wsId]: content },
    })),
  appendStreamingContent: (wsId, text) =>
    set((s) => ({
      streamingContent: {
        ...s.streamingContent,
        [wsId]: (s.streamingContent[wsId] || "") + text,
      },
    })),
  setToolActivities: (wsId, activities) =>
    set((s) => ({
      toolActivities: { ...s.toolActivities, [wsId]: activities },
    })),
  addToolActivity: (wsId, activity) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [wsId]: [...(s.toolActivities[wsId] || []), activity],
      },
    })),
  updateToolActivity: (wsId, toolUseId, updates) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [wsId]: (s.toolActivities[wsId] || []).map((a) =>
          a.toolUseId === toolUseId ? { ...a, ...updates } : a
        ),
      },
    })),
  toggleToolActivityCollapsed: (wsId, index) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [wsId]: (s.toolActivities[wsId] || []).map((a, i) =>
          i === index ? { ...a, collapsed: !a.collapsed } : a
        ),
      },
    })),

  // -- Diff --
  diffFiles: [],
  diffMergeBase: null,
  diffSelectedFile: null,
  diffContent: null,
  diffViewMode: "Unified",
  diffLoading: false,
  diffError: null,
  setDiffFiles: (files, mergeBase) =>
    set({ diffFiles: files, diffMergeBase: mergeBase }),
  setDiffSelectedFile: (path) => set({ diffSelectedFile: path }),
  setDiffContent: (content) => set({ diffContent: content }),
  setDiffViewMode: (mode) => set({ diffViewMode: mode }),
  setDiffLoading: (loading) => set({ diffLoading: loading }),
  setDiffError: (error) => set({ diffError: error }),
  clearDiff: () =>
    set({
      diffFiles: [],
      diffMergeBase: null,
      diffSelectedFile: null,
      diffContent: null,
      diffError: null,
    }),

  // -- Terminal --
  terminalTabs: {},
  activeTerminalTabId: null,
  terminalPanelVisible: false,
  setTerminalTabs: (wsId, tabs) =>
    set((s) => ({
      terminalTabs: { ...s.terminalTabs, [wsId]: tabs },
    })),
  addTerminalTab: (wsId, tab) =>
    set((s) => ({
      terminalTabs: {
        ...s.terminalTabs,
        [wsId]: [...(s.terminalTabs[wsId] || []), tab],
      },
      activeTerminalTabId: tab.id,
      terminalPanelVisible: true,
    })),
  removeTerminalTab: (wsId, tabId) =>
    set((s) => {
      const tabs = (s.terminalTabs[wsId] || []).filter((t) => t.id !== tabId);
      return {
        terminalTabs: { ...s.terminalTabs, [wsId]: tabs },
        activeTerminalTabId:
          s.activeTerminalTabId === tabId
            ? (tabs[0]?.id ?? null)
            : s.activeTerminalTabId,
      };
    }),
  setActiveTerminalTab: (id) => set({ activeTerminalTabId: id }),
  toggleTerminalPanel: () =>
    set((s) => ({ terminalPanelVisible: !s.terminalPanelVisible })),

  // -- UI --
  sidebarVisible: true,
  rightSidebarVisible: false,
  sidebarWidth: 260,
  rightSidebarWidth: 250,
  terminalHeight: 300,
  sidebarFilter: "all",
  repoCollapsed: {},
  fuzzyFinderOpen: false,
  toggleSidebar: () =>
    set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleRightSidebar: () =>
    set((s) => ({ rightSidebarVisible: !s.rightSidebarVisible })),
  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  setRightSidebarWidth: (w) => set({ rightSidebarWidth: w }),
  setTerminalHeight: (h) => set({ terminalHeight: h }),
  setSidebarFilter: (f) => set({ sidebarFilter: f }),
  toggleRepoCollapsed: (id) =>
    set((s) => ({
      repoCollapsed: {
        ...s.repoCollapsed,
        [id]: !s.repoCollapsed[id],
      },
    })),
  toggleFuzzyFinder: () =>
    set((s) => ({ fuzzyFinderOpen: !s.fuzzyFinderOpen })),

  // -- Modals --
  activeModal: null,
  modalData: {},
  openModal: (name, data = {}) => set({ activeModal: name, modalData: data }),
  closeModal: () => set({ activeModal: null, modalData: {} }),

  // -- Settings --
  worktreeBaseDir: "",
  setWorktreeBaseDir: (dir) => set({ worktreeBaseDir: dir }),
}));
