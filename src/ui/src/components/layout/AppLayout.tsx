import { useCallback } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { Sidebar } from "../sidebar/Sidebar";
import { ChatPanel } from "../chat/ChatPanel";
import { DiffViewer } from "../diff/DiffViewer";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { RightSidebar } from "../right-sidebar/RightSidebar";
import { FuzzyFinder } from "../fuzzy-finder/FuzzyFinder";
import { CommandPalette } from "../command-palette/CommandPalette";
import { Dashboard } from "./Dashboard";
import { StatusBar } from "./StatusBar";
import { UpdateBanner } from "./UpdateBanner";
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
  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);

  useKeyboardShortcuts();
  useBranchRefresh();

  const showDiff = diffSelectedFile !== null;

  const handleLeftResize = useCallback((delta: number) => {
    const current = useAppStore.getState().sidebarWidth;
    setSidebarWidth(Math.max(150, Math.min(600, current + delta)));
  }, [setSidebarWidth]);

  const handleRightResize = useCallback((delta: number) => {
    const current = useAppStore.getState().rightSidebarWidth;
    setRightSidebarWidth(Math.max(150, Math.min(600, current - delta)));
  }, [setRightSidebarWidth]);

  const handleTerminalResize = useCallback((delta: number) => {
    const current = useAppStore.getState().terminalHeight;
    setTerminalHeight(Math.max(100, Math.min(800, current - delta)));
  }, [setTerminalHeight]);

  return (
    <div className={styles.container}>
      <UpdateBanner />
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
              <Dashboard />
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
      {commandPaletteOpen && <CommandPalette />}
    </div>
  );
}
