import { useAppStore } from "../../stores/useAppStore";
import { useShallow } from "zustand/react/shallow";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const runningCount = useAppStore(
    (s) => s.workspaces.filter((ws) => ws.agent_status === "Running").length
  );
  const activeCount = useAppStore(
    (s) => s.workspaces.filter((ws) => ws.status === "Active").length
  );
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const updateVersion = useAppStore((s) => s.updateVersion);
  const setUpdateDismissed = useAppStore((s) => s.setUpdateDismissed);
  const connectedRemoteNames = useAppStore(
    useShallow((s) =>
      s.remoteConnections
        .filter((c) => s.activeRemoteIds.includes(c.id))
        .map((c) => c.name)
    )
  );

  return (
    <div className={styles.bar}>
      <div className={styles.stats}>
        {runningCount > 0 && (
          <span className={styles.statRunning}>
            <span className={styles.statDot} />
            {runningCount} running
          </span>
        )}
        <span className={styles.statMuted}>
          {activeCount} workspace{activeCount !== 1 ? "s" : ""}
        </span>
        {connectedRemoteNames.length > 0 && (
          <span className={styles.statMuted}>
            {connectedRemoteNames.join(", ")}
          </span>
        )}
      </div>
      {updateAvailable && (
        <button
          className={styles.statUpdate}
          onClick={() => setUpdateDismissed(false)}
          title={`Update available: v${updateVersion}`}
        >
          update available
        </button>
      )}
    </div>
  );
}
