/**
 * Per-row spinner shown in the sidebar while a workspace's
 * env-provider layer is resolving (direnv/mise/dotenv/nix-devshell).
 * Renders the same conic-gradient ring used for the agent-running
 * spinner so the visual language stays consistent — only the tooltip
 * differs, naming the plugin currently running and how long it has
 * been going. Returns `null` when the workspace isn't preparing, so
 * the caller can use this as a drop-in priority element in the
 * existing status-icon cascade.
 */
import { useTranslation } from "react-i18next";
import { useEnvElapsedSeconds } from "../../hooks/useEnvElapsedSeconds";
import styles from "./Sidebar.module.css";

interface WorkspaceEnvSpinnerProps {
  workspaceId: string;
}

/**
 * Map an internal plugin name (e.g. "env-direnv") to the user-facing
 * label shown in the sidebar tooltip. Mirrors the `display_name_for`
 * helper in `src/env_provider/mod.rs` so both surfaces agree.
 */
function displayName(plugin: string | null): string {
  switch (plugin) {
    case "env-direnv":
      return "direnv";
    case "env-mise":
      return "mise";
    case "env-dotenv":
      return "dotenv";
    case "env-nix-devshell":
      return "nix";
    default:
      return plugin ?? "";
  }
}

export function WorkspaceEnvSpinner({ workspaceId }: WorkspaceEnvSpinnerProps) {
  const { t } = useTranslation("settings");
  const { plugin, seconds } = useEnvElapsedSeconds(workspaceId);
  if (seconds === null) return null;
  const label = plugin
    ? t("env_loading_with_plugin", "Loading {{plugin}} ({{seconds}}s)…", {
        plugin: displayName(plugin),
        seconds,
      })
    : t("env_loading_progress", "Preparing environment ({{seconds}}s)…", {
        seconds,
      });
  return (
    <span className={styles.statusSpinner} aria-label={label} title={label}>
      <span className={styles.statusSpinnerRing} />
    </span>
  );
}
