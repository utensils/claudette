import { useAppStore } from "../../stores/useAppStore";
import { Sidebar } from "../sidebar/Sidebar";
import { ChatPanel } from "../chat/ChatPanel";
import { DiffViewer } from "../diff/DiffViewer";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { RightSidebar } from "../right-sidebar/RightSidebar";
import { FuzzyFinder } from "../fuzzy-finder/FuzzyFinder";
import { StatusBar } from "./StatusBar";
import { ModalRouter } from "../modals/ModalRouter";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useBranchRefresh } from "../../hooks/useBranchRefresh";
import styles from "./AppLayout.module.css";

export function AppLayout() {
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const rightSidebarVisible = useAppStore((s) => s.rightSidebarVisible);
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const terminalHeight = useAppStore((s) => s.terminalHeight);
  const fuzzyFinderOpen = useAppStore((s) => s.fuzzyFinderOpen);

  useKeyboardShortcuts();
  useBranchRefresh();

  const showDiff = diffSelectedFile !== null;

  return (
    <div className={styles.container}>
      <div className={styles.main}>
        {sidebarVisible && (
          <div className={styles.sidebar} style={{ width: sidebarWidth }}>
            <Sidebar />
          </div>
        )}
        <div className={styles.center}>
          <div className={styles.content}>
            {selectedWorkspaceId ? (
              showDiff ? (
                <DiffViewer />
              ) : (
                <ChatPanel />
              )
            ) : (
              <div className={styles.empty}>
                <p>Select a workspace to get started</p>
              </div>
            )}
          </div>
          {terminalPanelVisible && selectedWorkspaceId && (
            <div
              className={styles.terminal}
              style={{ height: terminalHeight }}
            >
              <TerminalPanel />
            </div>
          )}
        </div>
        {rightSidebarVisible && selectedWorkspaceId && (
          <div
            className={styles.rightSidebar}
            style={{ width: rightSidebarWidth }}
          >
            <RightSidebar />
          </div>
        )}
      </div>
      <StatusBar />
      <ModalRouter />
      {fuzzyFinderOpen && <FuzzyFinder />}
    </div>
  );
}
