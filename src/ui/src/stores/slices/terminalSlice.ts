import type { StateCreator } from "zustand";
import type {
  TerminalTab,
  TerminalPaneNode,
  TerminalPaneNodeId,
  TerminalSplitDirection,
} from "../../types";
import {
  allLeafIds as allPaneLeafIds,
  closeLeaf as closeLeafInTree,
  countLeaves as countPaneLeaves,
  makeLeaf as makePaneLeaf,
  splitLeaf as splitLeafInTree,
  updateSizes as updateSizesInTree,
} from "../terminalPaneTree";
import type { AppState } from "../useAppStore";

function orderTerminalTabs(tabs: TerminalTab[]): TerminalTab[] {
  return [...tabs].sort((a, b) => {
    const aKind = a.kind === "agent_task" ? 0 : 1;
    const bKind = b.kind === "agent_task" ? 0 : 1;
    if (aKind !== bKind) return aKind - bKind;
    const bySortOrder = a.sort_order - b.sort_order;
    if (bySortOrder !== 0) return bySortOrder;
    return a.id - b.id;
  });
}

export interface TerminalSlice {
  terminalTabs: Record<string, TerminalTab[]>;
  agentBackgroundTasksBySessionId: Record<string, TerminalTab[]>;
  // Active tab id is workspace-scoped: switching workspaces preserves each
  // workspace's last-active tab independently.
  activeTerminalTabId: Record<string, number | null>;
  terminalPanelVisible: boolean;
  /// Currently-running foreground commands, keyed by `wsId` then by `ptyId`.
  /// An entry exists only while that PTY's foreground command is running —
  /// it's added on `pty-command-detected`, removed on `pty-command-stopped`
  /// or `pty-exit`. The sidebar renders one row per entry, so a workspace
  /// with two terminals running `nxv dev` and `sleep 30` shows both.
  workspaceTerminalCommands: Record<string, Record<number, string | null>>;
  setTerminalTabs: (wsId: string, tabs: TerminalTab[]) => void;
  addTerminalTab: (wsId: string, tab: TerminalTab) => void;
  removeTerminalTab: (wsId: string, tabId: number) => void;
  upsertAgentTaskTerminalTab: (
    wsId: string,
    sessionId: string,
    tab: TerminalTab,
  ) => void;
  setActiveTerminalTab: (wsId: string, id: number | null) => void;
  toggleTerminalPanel: () => void;
  setWorkspaceRunningCommand: (
    wsId: string,
    ptyId: number,
    command: string | null,
  ) => void;
  clearWorkspaceRunningCommand: (wsId: string, ptyId: number) => void;

  // Per-tab split-pane layout (ephemeral — not persisted). Keyed by tab id.
  terminalPaneTrees: Record<number, TerminalPaneNode>;
  // Active leaf id per tab — which pane receives focus and keyboard shortcuts.
  activeTerminalPaneId: Record<number, TerminalPaneNodeId>;
  // Maximum leaves per tab before splits are refused. Exposed on state so
  // the UI can disable the split button at the cap.
  terminalPaneMaxLeaves: number;
  // Ensure a tab has a pane tree; no-op if one already exists. Returns the
  // (possibly pre-existing) root leaf id for convenience.
  ensurePaneTree: (tabId: number) => TerminalPaneNodeId;
  setPaneTree: (tabId: number, tree: TerminalPaneNode) => void;
  // Split the given leaf in two. Returns the id of the newly-created leaf,
  // or null if the split was refused (cap reached, leaf not in tree, etc).
  splitPane: (
    tabId: number,
    leafId: TerminalPaneNodeId,
    direction: TerminalSplitDirection,
  ) => TerminalPaneNodeId | null;
  // Close a single pane. Returns the id of the newly-focused leaf, or null
  // if the pane was the sole leaf (caller should close the tab instead).
  closePane: (
    tabId: number,
    leafId: TerminalPaneNodeId,
  ) => TerminalPaneNodeId | null;
  setActivePane: (tabId: number, leafId: TerminalPaneNodeId) => void;
  setPaneSizes: (
    tabId: number,
    splitId: TerminalPaneNodeId,
    sizes: [number, number],
  ) => void;
  setPanePtyId: (
    tabId: number,
    leafId: TerminalPaneNodeId,
    ptyId: number,
  ) => void;
  setPaneSpawnError: (
    tabId: number,
    leafId: TerminalPaneNodeId,
    error: string | null,
  ) => void;
}

export const createTerminalSlice: StateCreator<
  AppState,
  [],
  [],
  TerminalSlice
> = (set, get) => ({
  terminalTabs: {},
  agentBackgroundTasksBySessionId: {},
  activeTerminalTabId: {},
  terminalPanelVisible: false,
  workspaceTerminalCommands: {},
  setTerminalTabs: (wsId, tabs) =>
    set((s) => ({
      terminalTabs: { ...s.terminalTabs, [wsId]: orderTerminalTabs(tabs) },
    })),
  addTerminalTab: (wsId, tab) =>
    set((s) => ({
      terminalTabs: {
        ...s.terminalTabs,
        [wsId]: orderTerminalTabs([...(s.terminalTabs[wsId] || []), tab]),
      },
      activeTerminalTabId: { ...s.activeTerminalTabId, [wsId]: tab.id },
      terminalPanelVisible: true,
    })),
  removeTerminalTab: (wsId, tabId) =>
    set((s) => {
      const tabs = (s.terminalTabs[wsId] || []).filter((t) => t.id !== tabId);
      const wasActive = s.activeTerminalTabId[wsId] === tabId;
      // Drop the tab's pane tree and active-pane entry. The terminal panel
      // cleans up xterm instances by observing the terminalTabs map, and
      // we never want stale pane state to leak if the tab id is later
      // reused.
      const nextTrees = { ...s.terminalPaneTrees };
      delete nextTrees[tabId];
      const nextActivePane = { ...s.activeTerminalPaneId };
      delete nextActivePane[tabId];
      const nextTasks = Object.fromEntries(
        Object.entries(s.agentBackgroundTasksBySessionId)
          .map(([sessionId, sessionTabs]) => [
            sessionId,
            sessionTabs.filter((t) => t.id !== tabId),
          ])
          .filter(([, sessionTabs]) => sessionTabs.length > 0),
      );
      // When the user closes the last tab in the currently-selected
      // workspace, collapse the terminal panel — leaving an empty panel
      // mounted looks broken. If they re-open it later the panel's
      // tab-load effect will auto-create a fresh tab.
      const hideBecauseEmpty =
        tabs.length === 0 && s.selectedWorkspaceId === wsId;
      return {
        terminalTabs: { ...s.terminalTabs, [wsId]: tabs },
        agentBackgroundTasksBySessionId: nextTasks,
        activeTerminalTabId: wasActive
          ? { ...s.activeTerminalTabId, [wsId]: tabs[0]?.id ?? null }
          : s.activeTerminalTabId,
        terminalPaneTrees: nextTrees,
        activeTerminalPaneId: nextActivePane,
        terminalPanelVisible: hideBecauseEmpty ? false : s.terminalPanelVisible,
      };
    }),
  upsertAgentTaskTerminalTab: (wsId, sessionId, tab) =>
    set((s) => {
      const existingTabs = s.terminalTabs[wsId] ?? [];
      const sessionTabsPruned = existingTabs.filter(
        (t) =>
          !(
            t.kind === "agent_task" &&
            t.agent_chat_session_id === sessionId &&
            t.id !== tab.id
          ),
      );
      const existingIndex = sessionTabsPruned.findIndex((t) => t.id === tab.id);
      const tabs =
        existingIndex >= 0
          ? sessionTabsPruned.map((t) => (t.id === tab.id ? tab : t))
          : [...sessionTabsPruned, tab];
      return {
        terminalTabs: { ...s.terminalTabs, [wsId]: orderTerminalTabs(tabs) },
        agentBackgroundTasksBySessionId: {
          ...s.agentBackgroundTasksBySessionId,
          [sessionId]: [tab],
        },
      };
    }),
  setActiveTerminalTab: (wsId, id) =>
    set((s) => ({
      activeTerminalTabId: { ...s.activeTerminalTabId, [wsId]: id },
    })),
  toggleTerminalPanel: () =>
    set((s) => ({ terminalPanelVisible: !s.terminalPanelVisible })),
  setWorkspaceRunningCommand: (wsId, ptyId, command) =>
    set((s) => {
      const wsMap = { ...(s.workspaceTerminalCommands[wsId] ?? {}) };
      wsMap[ptyId] = command;
      return {
        workspaceTerminalCommands: {
          ...s.workspaceTerminalCommands,
          [wsId]: wsMap,
        },
      };
    }),
  clearWorkspaceRunningCommand: (wsId, ptyId) =>
    set((s) => {
      const wsMap = s.workspaceTerminalCommands[wsId];
      if (!wsMap || !(ptyId in wsMap)) return {};
      const next = { ...wsMap };
      delete next[ptyId];
      const nextOuter = { ...s.workspaceTerminalCommands };
      if (Object.keys(next).length === 0) {
        delete nextOuter[wsId];
      } else {
        nextOuter[wsId] = next;
      }
      return { workspaceTerminalCommands: nextOuter };
    }),

  // Pane-tree slice. State is ephemeral: if the app restarts, every tab
  // comes back as a single-leaf tree. See `terminalPaneTree.ts` for the
  // pure tree operations these setters wrap.
  terminalPaneTrees: {},
  activeTerminalPaneId: {},
  terminalPaneMaxLeaves: 6,
  ensurePaneTree: (tabId) => {
    const existing = get().terminalPaneTrees[tabId];
    if (existing && existing.kind === "leaf") {
      const stored = get().activeTerminalPaneId[tabId];
      if (stored !== existing.id) {
        set((s) => ({
          activeTerminalPaneId: {
            ...s.activeTerminalPaneId,
            [tabId]: existing.id,
          },
        }));
      }
      return existing.id;
    }
    if (existing && existing.kind === "split") {
      // Preserve the existing split layout. Use the stored active leaf if
      // it still identifies a leaf in the tree; otherwise fall back to the
      // leftmost leaf (and backfill activeTerminalPaneId so future reads
      // don't hit this branch again).
      const leaves = allPaneLeafIds(existing);
      const stored = get().activeTerminalPaneId[tabId];
      const pick = stored && leaves.includes(stored) ? stored : leaves[0];
      if (pick !== stored) {
        set((s) => ({
          activeTerminalPaneId: {
            ...s.activeTerminalPaneId,
            [tabId]: pick,
          },
        }));
      }
      return pick;
    }
    const leaf = makePaneLeaf();
    set((s) => ({
      terminalPaneTrees: { ...s.terminalPaneTrees, [tabId]: leaf },
      activeTerminalPaneId: { ...s.activeTerminalPaneId, [tabId]: leaf.id },
    }));
    return leaf.id;
  },
  setPaneTree: (tabId, tree) =>
    set((s) => ({
      terminalPaneTrees: { ...s.terminalPaneTrees, [tabId]: tree },
    })),
  splitPane: (tabId, leafId, direction) => {
    const state = get();
    const tree = state.terminalPaneTrees[tabId];
    if (!tree) return null;
    const cap = state.terminalPaneMaxLeaves;
    if (countPaneLeaves(tree) >= cap) return null;
    const { tree: nextTree, newLeafId } = splitLeafInTree(tree, leafId, direction);
    if (!newLeafId) return null;
    set((s) => ({
      terminalPaneTrees: { ...s.terminalPaneTrees, [tabId]: nextTree },
      // Focus the freshly created pane.
      activeTerminalPaneId: { ...s.activeTerminalPaneId, [tabId]: newLeafId },
    }));
    return newLeafId;
  },
  closePane: (tabId, leafId) => {
    const state = get();
    const tree = state.terminalPaneTrees[tabId];
    if (!tree) return null;
    const { tree: nextTree, closed, promotedLeafId } = closeLeafInTree(tree, leafId);
    if (!closed || !promotedLeafId) return null;
    set((s) => ({
      terminalPaneTrees: { ...s.terminalPaneTrees, [tabId]: nextTree },
      activeTerminalPaneId: {
        ...s.activeTerminalPaneId,
        [tabId]: promotedLeafId,
      },
    }));
    return promotedLeafId;
  },
  setActivePane: (tabId, leafId) =>
    set((s) => ({
      activeTerminalPaneId: { ...s.activeTerminalPaneId, [tabId]: leafId },
    })),
  setPaneSizes: (tabId, splitId, sizes) =>
    set((s) => {
      const tree = s.terminalPaneTrees[tabId];
      if (!tree) return {};
      const next = updateSizesInTree(tree, splitId, sizes);
      if (next === tree) return {};
      return { terminalPaneTrees: { ...s.terminalPaneTrees, [tabId]: next } };
    }),
  setPanePtyId: (tabId, leafId, ptyId) =>
    set((s) => {
      const tree = s.terminalPaneTrees[tabId];
      if (!tree) return {};
      const rewrite = (n: TerminalPaneNode): TerminalPaneNode => {
        if (n.kind === "leaf") {
          return n.id === leafId ? { ...n, ptyId, spawnError: null } : n;
        }
        const l = rewrite(n.children[0]);
        const r = rewrite(n.children[1]);
        if (l === n.children[0] && r === n.children[1]) return n;
        return { ...n, children: [l, r] };
      };
      const next = rewrite(tree);
      if (next === tree) return {};
      return { terminalPaneTrees: { ...s.terminalPaneTrees, [tabId]: next } };
    }),
  setPaneSpawnError: (tabId, leafId, error) =>
    set((s) => {
      const tree = s.terminalPaneTrees[tabId];
      if (!tree) return {};
      const rewrite = (n: TerminalPaneNode): TerminalPaneNode => {
        if (n.kind === "leaf") {
          if (n.id !== leafId) return n;
          // Clear ptyId whenever an error is recorded — use `!= null` so
          // an empty-string error still invalidates ptyId (truthy check
          // would miss `""` and leave the UI talking to a dead PTY).
          return {
            ...n,
            spawnError: error,
            ...(error != null ? { ptyId: undefined } : {}),
          };
        }
        const l = rewrite(n.children[0]);
        const r = rewrite(n.children[1]);
        if (l === n.children[0] && r === n.children[1]) return n;
        return { ...n, children: [l, r] };
      };
      const next = rewrite(tree);
      if (next === tree) return {};
      return { terminalPaneTrees: { ...s.terminalPaneTrees, [tabId]: next } };
    }),
});
