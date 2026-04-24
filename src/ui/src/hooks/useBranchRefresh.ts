import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { refreshBranches, refreshWorkspaceBranch } from "../services/tauri";

export function useBranchRefresh() {
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  useEffect(() => {
    const refresh = async () => {
      try {
        const updates = await refreshBranches();
        for (const [wsId, branchName] of updates) {
          updateWorkspace(wsId, { branch_name: branchName });
        }
      } catch {
        // Silently ignore refresh errors
      }
    };

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
    const wsId = selectedWorkspaceId;
    (async () => {
      try {
        const branch = await refreshWorkspaceBranch(wsId);
        if (branch !== null) {
          updateWorkspace(wsId, { branch_name: branch });
        }
      } catch {
        // Silently ignore refresh errors
      }
    })();
  }, [selectedWorkspaceId, updateWorkspace]);
}
