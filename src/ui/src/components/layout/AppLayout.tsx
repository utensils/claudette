import { useAppStore } from "../../stores/useAppStore";
import { Sidebar } from "../sidebar/Sidebar";
import { ChatPanel } from "../chat/ChatPanel";
import { DiffViewer } from "../diff/DiffViewer";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { RightSidebar } from "../right-sidebar/RightSidebar";
import { FuzzyFinder } from "../fuzzy-finder/FuzzyFinder";
import { StatusBar } from "./StatusBar";
import { ModalRouter } from "../modals/ModalRouter";
import { ResizeHandle } from "./ResizeHandle";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useBranchRefresh } from "../../hooks/useBranchRefresh";
import styles from "./AppLayout.module.css";

export function AppLayout() {
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const rightSidebarVisible = useAppStore((s) => s.rightSidebarVisible);
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth);
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const terminalHeight = useAppStore((s) => s.terminalHeight);
  const setTerminalHeight = useAppStore((s) => s.setTerminalHeight);
  const fuzzyFinderOpen = useAppStore((s) => s.fuzzyFinderOpen);

  useKeyboardShortcuts();
  useBranchRefresh();

  const showDiff = diffSelectedFile !== null;

  const handleLeftResize = (delta: number) => {
    const newWidth = Math.max(150, Math.min(600, sidebarWidth + delta));
    setSidebarWidth(newWidth);
  };

  const handleRightResize = (delta: number) => {
    const newWidth = Math.max(150, Math.min(600, rightSidebarWidth - delta));
    setRightSidebarWidth(newWidth);
  };

  const handleTerminalResize = (delta: number) => {
    const newHeight = Math.max(100, Math.min(800, terminalHeight - delta));
    setTerminalHeight(newHeight);
  };

  return (
    <div className={styles.container}>
      <div className={styles.main}>
        {sidebarVisible && (
          <>
            <div className={styles.sidebar} style={{ width: sidebarWidth }}>
              <Sidebar />
            </div>
            <ResizeHandle
              direction="horizontal"
              onResize={handleLeftResize}
            />
          </>
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
            <>
              <ResizeHandle
                direction="vertical"
                onResize={handleTerminalResize}
              />
              <div
                className={styles.terminal}
                style={{ height: terminalHeight }}
              >
                <TerminalPanel />
              </div>
            </>
          )}
        </div>
        {rightSidebarVisible && selectedWorkspaceId && (
          <>
            <ResizeHandle
              direction="horizontal"
              onResize={handleRightResize}
            />
            <div
              className={styles.rightSidebar}
              style={{ width: rightSidebarWidth }}
            >
              <RightSidebar />
            </div>
          </>
        )}
      </div>
      <StatusBar />
      <ModalRouter />
      {fuzzyFinderOpen && <FuzzyFinder />}
    </div>
  );
}
