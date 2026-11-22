import { PanelLeft, PanelBottom, PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { getHotkeyLabel, tooltipAttributes } from "../../hotkeys/display";
import styles from "./PanelToggles.module.css";

const isMac =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

export function PanelToggles() {
  const { t } = useTranslation();
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const rightSidebarVisible = useAppStore((s) => s.rightSidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);
  const keybindings = useAppStore((s) => s.keybindings);
  const sidebarShortcut = getHotkeyLabel("global.toggle-sidebar", keybindings, isMac);
  const terminalShortcut = getHotkeyLabel("global.toggle-terminal-panel", keybindings, isMac);
  const changesShortcut = getHotkeyLabel("global.toggle-right-sidebar", keybindings, isMac);

  return (
    <div className={styles.toggles}>
      <button
        type="button"
        className={`${styles.toggle} ${sidebarVisible ? styles.active : ""}`}
        onClick={toggleSidebar}
        {...tooltipAttributes(t("panel_toggle_sidebar"), "global.toggle-sidebar", keybindings, isMac, "bottom")}
        aria-label={t("panel_toggle_sidebar")}
        aria-pressed={sidebarVisible}
      >
        <PanelLeft size={16} />
        {sidebarShortcut && (
          <kbd aria-hidden="true" className={`shortcut-badge ${metaKeyHeld ? "shortcut-badge-visible" : ""}`}>{sidebarShortcut}</kbd>
        )}
      </button>
      <button
        type="button"
        className={`${styles.toggle} ${terminalPanelVisible ? styles.active : ""}`}
        onClick={toggleTerminalPanel}
        {...tooltipAttributes(t("panel_toggle_terminal"), "global.toggle-terminal-panel", keybindings, isMac, "bottom")}
        aria-label={t("panel_toggle_terminal")}
        aria-pressed={terminalPanelVisible}
      >
        <PanelBottom size={16} />
        {terminalShortcut && (
          <kbd aria-hidden="true" className={`shortcut-badge ${metaKeyHeld ? "shortcut-badge-visible" : ""}`}>{terminalShortcut}</kbd>
        )}
      </button>
      <button
        type="button"
        className={`${styles.toggle} ${rightSidebarVisible ? styles.active : ""}`}
        onClick={toggleRightSidebar}
        {...tooltipAttributes(t("panel_toggle_changes"), "global.toggle-right-sidebar", keybindings, isMac, "bottom")}
        aria-label={t("panel_toggle_changes")}
        aria-pressed={rightSidebarVisible}
      >
        <PanelRight size={16} />
        {changesShortcut && (
          <kbd aria-hidden="true" className={`shortcut-badge ${metaKeyHeld ? "shortcut-badge-visible" : ""}`}>{changesShortcut}</kbd>
        )}
      </button>
    </div>
  );
}
