import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { Sidebar } from "../sidebar/Sidebar";
import { ChatPanel } from "../chat/ChatPanel";
import { DiffViewer } from "../diff/DiffViewer";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { RightSidebar } from "../right-sidebar/RightSidebar";
import { FuzzyFinder } from "../fuzzy-finder/FuzzyFinder";
import { CommandPalette } from "../command-palette/CommandPalette";
import { Dashboard } from "./Dashboard";
import { ModalRouter } from "../modals/ModalRouter";
import { SettingsPage } from "../settings/SettingsPage";
import { ResizeHandle } from "./ResizeHandle";
import { ToastContainer } from "./Toast";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useBranchRefresh } from "../../hooks/useBranchRefresh";
import { useAutoUpdater } from "../../hooks/useAutoUpdater";
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
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const fuzzyFinderOpen = useAppStore((s) => s.fuzzyFinderOpen);
  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);

  useKeyboardShortcuts();
  useBranchRefresh();
  useAutoUpdater();

  const showDiff = diffSelectedFile !== null;

  // Ref for the .main flex container — CSS variables are set here.
  const mainRef = useRef<HTMLDivElement>(null);

  // Sync Zustand dimensions → CSS variables on mount, visibility toggles,
  // and workspace switches. During drag, ResizeHandle writes CSS vars
  // directly; this effect only runs for non-drag state changes.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    el.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
    el.style.setProperty("--right-sidebar-w", `${rightSidebarWidth}px`);
    el.style.setProperty("--terminal-h", `${terminalHeight}px`);
  }, [sidebarWidth, rightSidebarWidth, terminalHeight, sidebarVisible, rightSidebarVisible, terminalPanelVisible]);

  const handleLeftResizeEnd = useCallback((finalWidth: number) => {
    setSidebarWidth(finalWidth);
  }, [setSidebarWidth]);

  const handleRightResizeEnd = useCallback((finalWidth: number) => {
    setRightSidebarWidth(finalWidth);
  }, [setRightSidebarWidth]);

  const handleTerminalResizeEnd = useCallback((finalHeight: number) => {
    setTerminalHeight(finalHeight);
  }, [setTerminalHeight]);

  // Lazy-mount SettingsPage: defer initial mount until the user first opens
  // settings, then keep it mounted so subsequent toggles are instant.
  const [settingsMounted, setSettingsMounted] = useState(false);
  useEffect(() => {
    if (settingsOpen && !settingsMounted) setSettingsMounted(true);
  }, [settingsOpen, settingsMounted]);

  const isMac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

  return (
    <div className={styles.container} {...(isMac ? { "data-platform": "mac" } : {})}>
      <div className={styles.main} ref={mainRef}>
        {/*
          Settings is lazy-mounted on first open, then kept alive so
          subsequent toggles are instant.  The workspace subtree is
          ALWAYS mounted.  We swap visibility via CSS display:none so
          opening settings never unmounts the workspace tree —
          unmounting would destroy xterm instances and kill PTY children
          (same rationale as the terminal panel toggle below).
        */}
        {settingsMounted && (
          <div className={`${styles.viewPanel} ${settingsOpen ? "" : styles.hidden}`}>
            <SettingsPage />
          </div>
        )}
        <div className={`${styles.viewPanel} ${settingsOpen ? styles.hidden : ""}`}>
          {sidebarVisible && (
            <>
              <div className={styles.sidebar}>
                <Sidebar />
              </div>
              <ResizeHandle
                direction="horizontal"
                targetRef={mainRef}
                cssVar="--sidebar-w"
                min={150}
                max={600}
                onResizeEnd={handleLeftResizeEnd}
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
            {/*
              Always mount the terminal panel when a workspace is selected;
              drive visibility via a CSS class. Unmounting on collapse would
              dispose every xterm instance and kill every PTY child —
              toggling the panel must NOT destroy running shells.
              The ResizeHandle has no state worth preserving and is only
              useful when the panel is visible, so we conditionally render it.
            */}
            {selectedWorkspaceId && terminalPanelVisible && (
              <ResizeHandle
                direction="vertical"
                targetRef={mainRef}
                cssVar="--terminal-h"
                min={100}
                max={800}
                invert
                onResizeEnd={handleTerminalResizeEnd}
              />
            )}
            {selectedWorkspaceId && (
              <div
                className={`${styles.terminal} ${terminalPanelVisible ? "" : styles.hidden}`}
              >
                <TerminalPanel />
              </div>
            )}
          </div>
          {rightSidebarVisible && selectedWorkspaceId && (
            <>
              <ResizeHandle
                direction="horizontal"
                targetRef={mainRef}
                cssVar="--right-sidebar-w"
                min={150}
                max={600}
                invert
                onResizeEnd={handleRightResizeEnd}
              />
              <div className={styles.rightSidebar}>
                <RightSidebar />
              </div>
            </>
          )}
        </div>
      </div>
      <ModalRouter />
      {fuzzyFinderOpen && <FuzzyFinder />}
      {commandPaletteOpen && <CommandPalette />}
      <ToastContainer />
    </div>
  );
}
