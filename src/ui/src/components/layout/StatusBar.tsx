import { useAppStore } from "../../stores/useAppStore";
import { useShallow } from "zustand/react/shallow";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const rightSidebarVisible = useAppStore((s) => s.rightSidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);

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
      <div className={styles.spacer} />
      <button
        className={`${styles.toggle} ${sidebarVisible ? styles.active : ""}`}
        onClick={toggleSidebar}
        title="Toggle sidebar (⌘B)"
      >
        sidebar
      </button>
      <button
        className={`${styles.toggle} ${terminalPanelVisible ? styles.active : ""}`}
        onClick={toggleTerminalPanel}
        title="Toggle terminal (⌘`)"
      >
        terminal
      </button>
      <button
        className={`${styles.toggle} ${rightSidebarVisible ? styles.active : ""}`}
        onClick={toggleRightSidebar}
        title="Toggle changes (⌘D)"
      >
        changes
      </button>
    </div>
  );
}
