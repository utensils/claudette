import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { refreshBranches } from "../services/tauri";

export function useBranchRefresh() {
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const updates = await refreshBranches();
        for (const [wsId, branchName] of updates) {
          updateWorkspace(wsId, { branch_name: branchName });
        }
      } catch {
        // Silently ignore refresh errors
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [updateWorkspace]);
}
