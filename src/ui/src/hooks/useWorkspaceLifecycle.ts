import { useCallback } from "react";
import { useAppStore } from "../stores/useAppStore";
import {
  archiveWorkspace as archiveWorkspaceService,
  restoreWorkspace as restoreWorkspaceService,
} from "../services/tauri";

export interface ArchiveOptions {
  /** Skip the repo's archive_script. Pass `true` from surfaces where there
   *  is intrinsically nothing for a script to run against — e.g. the
   *  missing-worktree recovery banner, where the worktree directory is
   *  already gone, so any pre-archive script would fail to chdir into it
   *  before doing whatever it does. */
  skipScript?: boolean;
}

export type LifecycleResult =
  | { ok: true }
  | { ok: false; error: unknown };

/**
 * Workspace archive / restore actions that keep store state and selection
 * in sync with the backend.
 *
 * Mirrors the optimistic-update pattern that lives in `Sidebar.handleArchive`
 * / `Sidebar.handleRestore`: snapshot pre-state, optimistically flip the
 * workspace, deselect it if it was active, then reconcile against the
 * backend response (rollback on failure, remove on hard-delete).
 *
 * The Sidebar handlers also wrap an archive-script confirmation modal in
 * front of this — that flow is Sidebar-specific and is intentionally NOT
 * pulled into this hook so the hook stays a thin lifecycle primitive that
 * other surfaces (ChatErrorBanner's worktree-recovery banner, future
 * command-palette actions, etc.) can reuse without inheriting the script
 * UX.
 */
export function useWorkspaceLifecycle() {
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const archive = useCallback(
    async (wsId: string, opts: ArchiveOptions = {}): Promise<LifecycleResult> => {
      // Re-read state at call time so a render between hook construction
      // and invocation doesn't leave us snapshotting stale data.
      const pre = useAppStore.getState();
      const snapshot = pre.workspaces.find((w) => w.id === wsId);
      const wasSelected = pre.selectedWorkspaceId === wsId;

      updateWorkspace(wsId, {
        status: "Archived",
        worktree_path: null,
        agent_status: "Stopped",
      });
      // Deselecting drops the user back to the "Start a workspace" empty
      // state — the same view the sidebar's archive button takes you to.
      if (wasSelected) selectWorkspace(null);

      try {
        const deleted = await archiveWorkspaceService(wsId, opts.skipScript);
        if (deleted) removeWorkspace(wsId);
        return { ok: true };
      } catch (error) {
        if (snapshot) {
          updateWorkspace(wsId, snapshot);
          // Only restore selection if the user didn't navigate elsewhere
          // while the backend call was in flight.
          if (wasSelected && useAppStore.getState().selectedWorkspaceId === null) {
            selectWorkspace(wsId);
          }
        }
        return { ok: false, error };
      }
    },
    [updateWorkspace, removeWorkspace, selectWorkspace],
  );

  const restore = useCallback(
    async (wsId: string): Promise<LifecycleResult> => {
      try {
        const path = await restoreWorkspaceService(wsId);
        updateWorkspace(wsId, { status: "Active", worktree_path: path });
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    },
    [updateWorkspace],
  );

  return { archive, restore };
}
