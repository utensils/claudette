import { useAppStore } from "../../stores/useAppStore";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const rightSidebarVisible = useAppStore((s) => s.rightSidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const workspaces = useAppStore((s) => s.workspaces);

  const activeRemoteIds = useAppStore((s) => s.activeRemoteIds);
  const remoteConnections = useAppStore((s) => s.remoteConnections);

  const runningCount = workspaces.filter(
    (ws) => ws.agent_status === "Running"
  ).length;
  const activeCount = workspaces.filter(
    (ws) => ws.status === "Active"
  ).length;
  const connectedRemotes = remoteConnections.filter((c) =>
    activeRemoteIds.includes(c.id)
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
        {connectedRemotes.length > 0 && (
          <span className={styles.statMuted}>
            {connectedRemotes.map((c) => c.name).join(", ")}
          </span>
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
