import { useAppStore } from "../../stores/useAppStore";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const rightSidebarVisible = useAppStore((s) => s.rightSidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);

  return (
    <div className={styles.bar}>
      <div className={styles.spacer} />
      <button
        className={`${styles.toggle} ${sidebarVisible ? styles.active : ""}`}
        onClick={toggleSidebar}
        title="Toggle sidebar"
      >
        sidebar
      </button>
      <button
        className={`${styles.toggle} ${terminalPanelVisible ? styles.active : ""}`}
        onClick={toggleTerminalPanel}
        title="Toggle terminal"
      >
        terminal
      </button>
      <button
        className={`${styles.toggle} ${rightSidebarVisible ? styles.active : ""}`}
        onClick={toggleRightSidebar}
        title="Toggle changes"
      >
        changes
      </button>
    </div>
  );
}
