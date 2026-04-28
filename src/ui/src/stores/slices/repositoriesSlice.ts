import type { StateCreator } from "zustand";
import type { Repository } from "../../types";
import type { AppState } from "../useAppStore";

export interface RepositoriesSlice {
  repositories: Repository[];
  setRepositories: (repos: Repository[]) => void;
  addRepository: (repo: Repository) => void;
  updateRepository: (id: string, updates: Partial<Repository>) => void;
  removeRepository: (id: string) => void;
}

export const createRepositoriesSlice: StateCreator<
  AppState,
  [],
  [],
  RepositoriesSlice
> = (set) => ({
  repositories: [],
  setRepositories: (repos) => set({ repositories: repos }),
  addRepository: (repo) =>
    set((s) => ({ repositories: [...s.repositories, repo] })),
  updateRepository: (id, updates) =>
    set((s) => ({
      repositories: s.repositories.map((r) =>
        r.id === id ? { ...r, ...updates } : r,
      ),
    })),
  removeRepository: (id) =>
    set((s) => {
      const removedWsIds = s.workspaces
        .filter((w) => w.repository_id === id)
        .map((w) => w.id);
      const removedWsIdSet = new Set(removedWsIds);
      const newTerminalTabs = { ...s.terminalTabs };
      const newActiveTerminalTabId = { ...s.activeTerminalTabId };
      const newWorkspaceTerminalCommands = { ...s.workspaceTerminalCommands };
      const newUnreadCompletions = new Set(s.unreadCompletions);
      // Collect all tab ids we're about to orphan, then drop their pane
      // trees and active-pane entries alongside the workspace-keyed maps.
      const orphanedTabIds = new Set<number>();
      for (const wsId of removedWsIds) {
        for (const tab of s.terminalTabs[wsId] ?? []) orphanedTabIds.add(tab.id);
        delete newTerminalTabs[wsId];
        delete newActiveTerminalTabId[wsId];
        delete newWorkspaceTerminalCommands[wsId];
        newUnreadCompletions.delete(wsId);
      }
      const newPaneTrees = { ...s.terminalPaneTrees };
      const newActivePane = { ...s.activeTerminalPaneId };
      for (const tabId of orphanedTabIds) {
        delete newPaneTrees[tabId];
        delete newActivePane[tabId];
      }
      const newDiffTabs = { ...s.diffTabsByWorkspace };
      for (const wsId of removedWsIds) {
        delete newDiffTabs[wsId];
      }
      return {
        repositories: s.repositories.filter((r) => r.id !== id),
        workspaces: s.workspaces.filter((w) => w.repository_id !== id),
        // If the selected workspace belonged to the removed repo, deselect
        // it so the rest of the app doesn't point at a vanished id.
        selectedWorkspaceId:
          s.selectedWorkspaceId && removedWsIdSet.has(s.selectedWorkspaceId)
            ? null
            : s.selectedWorkspaceId,
        terminalTabs: newTerminalTabs,
        activeTerminalTabId: newActiveTerminalTabId,
        workspaceTerminalCommands: newWorkspaceTerminalCommands,
        unreadCompletions: newUnreadCompletions,
        terminalPaneTrees: newPaneTrees,
        activeTerminalPaneId: newActivePane,
        diffTabsByWorkspace: newDiffTabs,
      };
    }),
});
