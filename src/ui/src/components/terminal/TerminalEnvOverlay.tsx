/**
 * Banner shown inside the Terminal panel while a workspace's env-
 * provider layer is resolving. The previous `waitForWorkspaceEnvironment`
 * was a silent 30-second poll loop — users on slow Nix flakes would
 * see nothing happen and assume the terminal was broken. This surface
 * names the active plugin and ticks elapsed time so the user has a
 * concrete signal that work is in flight.
 *
 * Copy is deliberately scenario-neutral: the same banner renders both
 * when a brand-new workspace is preparing (no terminal mounted yet)
 * and when an existing workspace reloads its env on selection
 * (`workspacesSlice.selectWorkspace` flips status to `preparing` for
 * any non-remote workspace, even with terminal tabs already open).
 * A "terminal opens when ready" hint would lie in the second case.
 *
 * Returns `null` when the workspace isn't preparing so the parent can
 * mount it unconditionally.
 */
import { useTranslation } from "react-i18next";
import { useEnvElapsedSeconds } from "../../hooks/useEnvElapsedSeconds";
import { Spinner } from "../shared/Spinner";
import styles from "./TerminalPanel.module.css";

interface TerminalEnvOverlayProps {
  workspaceId: string | null;
}

function displayName(plugin: string | null): string {
  switch (plugin) {
    case "env-direnv":
      return "direnv";
    case "env-mise":
      return "mise";
    case "env-dotenv":
      return "dotenv";
    case "env-nix-devshell":
      return "nix devshell";
    default:
      return plugin ?? "";
  }
}

export function TerminalEnvOverlay({ workspaceId }: TerminalEnvOverlayProps) {
  const { t } = useTranslation("settings");
  const { plugin, seconds } = useEnvElapsedSeconds(workspaceId);
  if (seconds === null) return null;
  const message = plugin
    ? t(
        "terminal_env_overlay_with_plugin",
        "Loading {{plugin}} environment ({{seconds}}s)…",
        { plugin: displayName(plugin), seconds },
      )
    : t(
        "terminal_env_overlay_progress",
        "Preparing workspace environment ({{seconds}}s)…",
        { seconds },
      );
  return (
    <div className={styles.envOverlay} role="status" aria-live="polite">
      <Spinner className={styles.envOverlaySpinner} size={14} />
      <span>{message}</span>
    </div>
  );
}
