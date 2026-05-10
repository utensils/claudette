import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { prepareWorkspaceEnvironment } from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";

/**
 * Phase + payload shape mirroring `WorkspaceEnvProgressPayload` in
 * `src-tauri/src/commands/env.rs`. The Rust side broadcasts these
 * for **every** env-resolve call site (workspace creation, selection,
 * agent spawn, PTY spawn, env-panel reload), so this listener has to
 * handle progress for workspaces other than the currently selected one.
 */
type EnvProgressPhase = "started" | "finished";
interface WorkspaceEnvProgressPayload {
  workspace_id: string;
  plugin: string;
  phase: EnvProgressPhase;
  elapsed_ms: number;
  ok?: boolean;
}

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
  const setWorkspaceEnvironmentProgress = useAppStore(
    (s) => s.setWorkspaceEnvironmentProgress,
  );
  const addToast = useAppStore((s) => s.addToast);

  // Global listener: subscribe once per app session and route every
  // workspace_env_progress event into the store, regardless of which
  // workspace is currently selected. This lets the sidebar show a
  // "loading env-direnv (12s)…" spinner on row B while the user is
  // viewing workspace A, and the terminal/chat composer on every
  // open panel see the same updates without each having to listen.
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    listen<WorkspaceEnvProgressPayload>("workspace_env_progress", (event) => {
      if (!mounted) return;
      const { workspace_id, plugin, phase } = event.payload;
      if (phase === "started") {
        setWorkspaceEnvironmentProgress(workspace_id, plugin);
      } else {
        setWorkspaceEnvironmentProgress(workspace_id, null);
      }
    }).then((stop) => {
      if (!mounted) {
        stop();
        return;
      }
      unlisten = stop;
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [setWorkspaceEnvironmentProgress]);

  // Per-selection prepare: when the user activates a local workspace,
  // kick off `prepare_workspace_environment` so the chat composer +
  // any opened terminal can wait on a definite "ready" signal. Remote
  // workspaces skip this — their env is resolved on the remote.
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
