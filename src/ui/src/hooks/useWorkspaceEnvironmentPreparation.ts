import { useEffect } from "react";
import { prepareWorkspaceEnvironment } from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";

export function useWorkspaceEnvironmentPreparation() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectedWorkspaceRemoteConnectionId = useAppStore((s) => {
    if (!s.selectedWorkspaceId) return null;
    const selectedWorkspace = s.workspaces.find(
      (w) => w.id === s.selectedWorkspaceId,
    );
    return selectedWorkspace?.remote_connection_id;
  });
  const setWorkspaceEnvironment = useAppStore((s) => s.setWorkspaceEnvironment);
  const addToast = useAppStore((s) => s.addToast);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (selectedWorkspaceRemoteConnectionId === undefined) return;
    if (selectedWorkspaceRemoteConnectionId) {
      setWorkspaceEnvironment(selectedWorkspaceId, "ready");
      return;
    }

    const workspaceId = selectedWorkspaceId;
    let cancelled = false;
    setWorkspaceEnvironment(workspaceId, "preparing");

    prepareWorkspaceEnvironment(workspaceId)
      .then(() => {
        if (!cancelled) setWorkspaceEnvironment(workspaceId, "ready");
      })
      .catch((err) => {
        if (cancelled) return;
        const message = String(err);
        setWorkspaceEnvironment(workspaceId, "error", message);
        addToast(`Workspace environment failed: ${message}`);
      });

    return () => {
      cancelled = true;
      if (
        useAppStore.getState().workspaceEnvironment[workspaceId]?.status ===
        "preparing"
      ) {
        setWorkspaceEnvironment(workspaceId, "idle");
      }
    };
  }, [
    selectedWorkspaceId,
    selectedWorkspaceRemoteConnectionId,
    setWorkspaceEnvironment,
    addToast,
  ]);
}
