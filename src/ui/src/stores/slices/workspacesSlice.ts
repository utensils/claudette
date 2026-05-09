import type { StateCreator } from "zustand";
import type { Workspace } from "../../types";
import type { AppState } from "../useAppStore";

export type WorkspaceEnvironmentStatus = "idle" | "preparing" | "ready" | "error";

export interface WorkspaceEnvironmentPreparation {
  status: WorkspaceEnvironmentStatus;
  error?: string;
}

export interface WorkspacesSlice {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  workspaceEnvironment: Record<string, WorkspaceEnvironmentPreparation>;
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (ws: Workspace) => void;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  removeWorkspace: (id: string) => void;
  selectWorkspace: (id: string | null) => void;
  setWorkspaceEnvironment: (
    id: string,
    status: WorkspaceEnvironmentStatus,
    error?: string,
  ) => void;
}

export const createWorkspacesSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspacesSlice
> = (set) => ({
  workspaces: [],
  selectedWorkspaceId: null,
  workspaceEnvironment: {},
  setWorkspaces: (workspaces) => set({ workspaces }),
  // Idempotent by id: workspace creates can race between the Tauri
  // command's response (Sidebar calls `addWorkspace` after the await
  // resolves) and the `workspaces-changed` event the IPC hook emits.
  // Whichever fires first wins; the other becomes a merge-update so
  // the row never doubles in the sidebar.
  //
  // The merge preserves the existing `agent_status` ONLY when the
  // incoming row's lifecycle `status` matches the existing one. That
  // field isn't a database column — `db::list_workspaces` synthesizes
  // Idle (or Stopped for archived) on every read. The authoritative
  // value is normally the one already in the React store, set by
  // `useAgentStream` / `ChatPanel` from live agent events. Letting an
  // incoming row's synthetic Idle clobber a live "Running" leaves the
  // sidebar showing inactive for workspaces with active agents.
  //
  // BUT a `status` transition (Active→Archived, Archived→Active) is a
  // real lifecycle event whose synthetic agent_status IS authoritative —
  // an archive really does stop the agent (we kill the process inline
  // in `archive_workspace_inner`), so the incoming Stopped must win or
  // the sidebar lies about the row still being busy. Same logic in
  // reverse for restore. `updateWorkspace` remains the explicit-setter
  // path for callers that want to override agent_status directly.
  addWorkspace: (ws) =>
    set((s) => {
      const idx = s.workspaces.findIndex((w) => w.id === ws.id);
      if (idx === -1) {
        return { workspaces: [...s.workspaces, ws] };
      }
      const merged = [...s.workspaces];
      const existing = merged[idx];
      const statusChanged = existing.status !== ws.status;
      merged[idx] = statusChanged
        ? { ...existing, ...ws }
        : { ...existing, ...ws, agent_status: existing.agent_status };
      return { workspaces: merged };
    }),
  updateWorkspace: (id, updates) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, ...updates } : w,
      ),
    })),
  removeWorkspace: (id) =>
    set((s) => {
      const newUnreadCompletions = new Set(s.unreadCompletions);
      newUnreadCompletions.delete(id);
      // Drop all per-workspace terminal state for the removed workspace.
      // The cleanup effect in TerminalPanel watches `terminalTabs` and tears
      // down xterm instances and PTYs whose tab ids no longer exist in any
      // workspace; the other maps are value-keyed by workspace id.
      const orphanedTabIds = (s.terminalTabs[id] ?? []).map((t) => t.id);
      const newTerminalTabs = { ...s.terminalTabs };
      delete newTerminalTabs[id];
      const newActiveTerminalTabId = { ...s.activeTerminalTabId };
      delete newActiveTerminalTabId[id];
      const newWorkspaceTerminalCommands = { ...s.workspaceTerminalCommands };
      delete newWorkspaceTerminalCommands[id];
      const newPendingTerminalCommands = s.pendingTerminalCommands.filter(
        (cmd) => cmd.workspaceId !== id,
      );
      const newPaneTrees = { ...s.terminalPaneTrees };
      const newActivePane = { ...s.activeTerminalPaneId };
      for (const tabId of orphanedTabIds) {
        delete newPaneTrees[tabId];
        delete newActivePane[tabId];
      }
      const newDiffTabs = { ...s.diffTabsByWorkspace };
      delete newDiffTabs[id];
      const newDiffSelection = { ...s.diffSelectionByWorkspace };
      delete newDiffSelection[id];
      const newChatDrafts = { ...s.chatDrafts };
      for (const session of s.sessionsByWorkspace[id] ?? []) {
        delete newChatDrafts[session.id];
      }
      // Drop the unified workspace-tab order so a workspace id reused
      // later (e.g. restore-from-archive collision) starts from default
      // sessions→diffs→files layout instead of dredging up old entries.
      const newTabOrder = { ...s.tabOrderByWorkspace };
      delete newTabOrder[id];
      const newWorkspaceEnvironment = { ...s.workspaceEnvironment };
      delete newWorkspaceEnvironment[id];
      return {
        workspaces: s.workspaces.filter((w) => w.id !== id),
        selectedWorkspaceId:
          s.selectedWorkspaceId === id ? null : s.selectedWorkspaceId,
        unreadCompletions: newUnreadCompletions,
        terminalTabs: newTerminalTabs,
        activeTerminalTabId: newActiveTerminalTabId,
        workspaceTerminalCommands: newWorkspaceTerminalCommands,
        pendingTerminalCommands: newPendingTerminalCommands,
        terminalPaneTrees: newPaneTrees,
        activeTerminalPaneId: newActivePane,
        diffTabsByWorkspace: newDiffTabs,
        diffSelectionByWorkspace: newDiffSelection,
        chatDrafts: newChatDrafts,
        tabOrderByWorkspace: newTabOrder,
        workspaceEnvironment: newWorkspaceEnvironment,
      };
    }),
  selectWorkspace: (id) =>
    set((s) => {
      if (id === s.selectedWorkspaceId) return s;

      // Save the outgoing workspace's active diff selection, or clear it if
      // the user left that workspace in chat view (e.g. they clicked a chat
      // tab, which nulls diffSelectedFile while leaving diff tabs open).
      // Without the explicit clear, a stale selection from an earlier diff
      // visit would resurrect the diff view on workspace return.
      const prev = s.selectedWorkspaceId;
      let selectionMap = s.diffSelectionByWorkspace;
      if (prev) {
        if (s.diffSelectedFile) {
          selectionMap = {
            ...selectionMap,
            [prev]: { path: s.diffSelectedFile, layer: s.diffSelectedLayer },
          };
        } else if (prev in selectionMap) {
          const next = { ...selectionMap };
          delete next[prev];
          selectionMap = next;
        }
      }

      // Restore incoming workspace's selection, validated against open tabs.
      const restored = id ? selectionMap[id] : undefined;
      const incomingTabs = id ? (s.diffTabsByWorkspace[id] ?? []) : [];
      const tabExists =
        restored?.path != null &&
        incomingTabs.some(
          (t) => t.path === restored.path && t.layer === restored.layer,
        );

      const updates: Partial<AppState> = {
        selectedWorkspaceId: id,
        rightSidebarTab: "files",
        diffSelectionByWorkspace: selectionMap,
        diffSelectedFile: tabExists ? restored!.path : null,
        diffSelectedLayer: tabExists ? restored!.layer : null,
        diffContent: null,
        diffError: null,
        diffPreviewMode: "diff",
        diffPreviewContent: null,
        diffPreviewLoading: false,
        diffPreviewError: null,
        // diffMergeBase is a single global string keyed off whichever
        // workspace last set it. Clearing on switch prevents the file
        // viewer's git gutter (which reads diffMergeBase) from comparing
        // against the prior workspace's merge-base SHA when the right
        // sidebar is hidden — without this, RightSidebar's clearDiff()
        // never runs because the component isn't mounted, and the stale
        // SHA leaks across the boundary.
        diffMergeBase: null,
      };
      if (id && s.unreadCompletions.has(id)) {
        const next = new Set(s.unreadCompletions);
        next.delete(id);
        updates.unreadCompletions = next;
      }
      return updates;
    }),
  setWorkspaceEnvironment: (id, status, error) =>
    set((s) => ({
      workspaceEnvironment: {
        ...s.workspaceEnvironment,
        [id]: error ? { status, error } : { status },
      },
    })),
});
