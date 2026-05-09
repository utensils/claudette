import { useEffect } from "react";
import { prepareWorkspaceEnvironment } from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";

export function useWorkspaceEnvironmentPreparation() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectedWorkspace = useAppStore((s) =>
    s.selectedWorkspaceId
      ? s.workspaces.find((w) => w.id === s.selectedWorkspaceId) ?? null
      : null,
  );
  const setWorkspaceEnvironment = useAppStore((s) => s.setWorkspaceEnvironment);
  const addToast = useAppStore((s) => s.addToast);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedWorkspace) return;
    if (selectedWorkspace.remote_connection_id) {
      setWorkspaceEnvironment(selectedWorkspaceId, "ready");
      return;
    }

    let cancelled = false;
    setWorkspaceEnvironment(selectedWorkspaceId, "preparing");

    prepareWorkspaceEnvironment(selectedWorkspaceId)
      .then(() => {
        if (!cancelled) setWorkspaceEnvironment(selectedWorkspaceId, "ready");
      })
      .catch((err) => {
        if (cancelled) return;
        const message = String(err);
        setWorkspaceEnvironment(selectedWorkspaceId, "error", message);
        addToast(`Workspace environment failed: ${message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedWorkspaceId,
    selectedWorkspace,
    setWorkspaceEnvironment,
    addToast,
  ]);
}
