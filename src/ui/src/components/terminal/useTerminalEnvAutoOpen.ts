import { useEffect, useRef } from "react";

/**
 * Auto-opens the terminal panel when a workspace's environment begins
 * preparing (env-provider resolve, nix devshell, direnv, etc.).
 *
 * Two layers of guard, in order:
 *
 * 1. `userDismissed` — once the user explicitly toggled the panel closed,
 *    we never auto-open again (across any workspace) until they manually
 *    re-open it. This is the global override.
 *
 * 2. Per-workspace `Set` — even before the user has dismissed once, every
 *    workspace only triggers an auto-open the first time its env starts
 *    preparing. `selectWorkspace` briefly resets env status to "preparing"
 *    on every switch, so a string | null guard would clear on navigation
 *    away and re-open on the return trip.
 */
export function useTerminalEnvAutoOpen(
  selectedWorkspaceId: string | null,
  workspaceEnvironmentPreparing: boolean,
  claudetteTerminalEnabled: boolean,
  terminalPanelVisible: boolean,
  userDismissed: boolean,
  setTerminalPanelVisible: (visible: boolean) => void,
): void {
  const autoOpenedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (userDismissed) return;
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
    userDismissed,
    setTerminalPanelVisible,
  ]);
}
