import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { refreshBranches } from "../services/tauri";

export function useBranchRefresh() {
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);

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
}
