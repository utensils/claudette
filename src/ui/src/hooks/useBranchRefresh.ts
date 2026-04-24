import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { refreshBranches, refreshWorkspaceBranch } from "../services/tauri";
import type { Workspace } from "../types/workspace";

type UpdateWorkspace = (id: string, updates: Partial<Workspace>) => void;

/**
 * Poll all active workspaces for external branch-name drift and mirror any
 * detected changes into the Zustand store. Errors are swallowed so a
 * transient git/IPC failure doesn't break the polling loop.
 */
export async function pollAndApplyBranchUpdates(
  updateWorkspace: UpdateWorkspace,
): Promise<void> {
  try {
    const updates = await refreshBranches();
    for (const [wsId, branchName] of updates) {
      updateWorkspace(wsId, { branch_name: branchName });
    }
  } catch {
    // Silently ignore refresh errors
  }
}

/**
 * Immediate refresh for a single workspace — called when the user selects
 * one so external renames appear without waiting on the 5s poll. Returns
 * the new branch name if one was applied (useful for tests).
 */
export async function refreshSelectedWorkspaceBranch(
  workspaceId: string,
  updateWorkspace: UpdateWorkspace,
): Promise<string | null> {
  try {
    const branch = await refreshWorkspaceBranch(workspaceId);
    if (branch !== null) {
      updateWorkspace(workspaceId, { branch_name: branch });
    }
    return branch;
  } catch {
    return null;
  }
}

export function useBranchRefresh() {
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  useEffect(() => {
    const refresh = () => pollAndApplyBranchUpdates(updateWorkspace);

    // Run immediately on mount, then poll.
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [updateWorkspace]);

  // Immediate refresh when the user selects a workspace — picks up branch
  // renames done in the integrated terminal without waiting for the next
  // poll tick.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    refreshSelectedWorkspaceBranch(selectedWorkspaceId, updateWorkspace);
  }, [selectedWorkspaceId, updateWorkspace]);
}
