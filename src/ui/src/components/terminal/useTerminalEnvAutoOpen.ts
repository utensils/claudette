import { useEffect, useRef } from "react";

/**
 * Auto-opens the terminal panel when a workspace's environment begins
 * preparing (env-provider resolve, nix devshell, direnv, etc.).
 *
 * Uses a Set so we remember every workspace we've already opened for —
 * not just the last one. selectWorkspace briefly resets env status to
 * "preparing" on every workspace switch, so a string | null guard would
 * clear on navigation away and re-open the panel when the user switches
 * back, ignoring any explicit close they made in between.
 */
export function useTerminalEnvAutoOpen(
  selectedWorkspaceId: string | null,
  workspaceEnvironmentPreparing: boolean,
  claudetteTerminalEnabled: boolean,
  terminalPanelVisible: boolean,
  setTerminalPanelVisible: (visible: boolean) => void,
): void {
  const autoOpenedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedWorkspaceId || !workspaceEnvironmentPreparing || !claudetteTerminalEnabled)
      return;
    if (autoOpenedRef.current.has(selectedWorkspaceId)) return;
    autoOpenedRef.current.add(selectedWorkspaceId);
    if (!terminalPanelVisible) {
      setTerminalPanelVisible(true);
    }
  }, [
    selectedWorkspaceId,
    workspaceEnvironmentPreparing,
    claudetteTerminalEnabled,
    terminalPanelVisible,
    setTerminalPanelVisible,
  ]);
}
