import { PanelLeft, PanelBottom, PanelRight } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import styles from "./PanelToggles.module.css";

const isMac =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
const mod = isMac ? "⌘" : "Ctrl+";

export function PanelToggles() {
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const rightSidebarVisible = useAppStore((s) => s.rightSidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);

  return (
    <div className={styles.toggles}>
      <button
        type="button"
        className={`${styles.toggle} ${sidebarVisible ? styles.active : ""}`}
        onClick={toggleSidebar}
        title={`Toggle sidebar (${mod}B)`}
        aria-label="Toggle sidebar"
        aria-pressed={sidebarVisible}
      >
        <PanelLeft size={16} />
        <kbd aria-hidden="true" className={`shortcut-badge ${metaKeyHeld ? "shortcut-badge-visible" : ""}`}>{mod}B</kbd>
      </button>
      <button
        type="button"
        className={`${styles.toggle} ${terminalPanelVisible ? styles.active : ""}`}
        onClick={toggleTerminalPanel}
        title={`Toggle terminal (${mod}\`)`}
        aria-label="Toggle terminal"
        aria-pressed={terminalPanelVisible}
      >
        <PanelBottom size={16} />
        <kbd aria-hidden="true" className={`shortcut-badge ${metaKeyHeld ? "shortcut-badge-visible" : ""}`}>{mod}`</kbd>
      </button>
      <button
        type="button"
        className={`${styles.toggle} ${rightSidebarVisible ? styles.active : ""}`}
        onClick={toggleRightSidebar}
        title={`Toggle changes (${mod}D)`}
        aria-label="Toggle changes"
        aria-pressed={rightSidebarVisible}
      >
        <PanelRight size={16} />
        <kbd aria-hidden="true" className={`shortcut-badge ${metaKeyHeld ? "shortcut-badge-visible" : ""}`}>{mod}D</kbd>
      </button>
    </div>
  );
}
