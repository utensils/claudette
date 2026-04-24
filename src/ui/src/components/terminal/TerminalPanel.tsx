import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  createTerminalTab,
  deleteTerminalTab,
  listTerminalTabs,
} from "../../services/tauri";
import {
  cycleTabId,
  terminalKeyAction,
  type TerminalKeyAction,
} from "./terminalShortcuts";
import { neighborLeaf } from "../../stores/terminalPaneTree";
import {
  focusActiveTerminal,
  focusChatPrompt,
} from "../../utils/focusTargets";
import { TerminalPaneTree } from "./TerminalPaneTree";
import styles from "./TerminalPanel.module.css";

/**
 * TerminalPanel composes the per-workspace tab bar with a per-tab split-pane
 * tree. The tree is owned by the Zustand store; this component is mostly
 * glue: it wires keyboard shortcuts, creates pane trees when tabs appear,
 * and tears down pane trees when tabs disappear.
 *
 * Each tab's pane tree is rendered in its own absolutely-positioned
 * container. Inactive tabs get `display:none` so their xterm instances keep
 * running (shells stay alive while the user works in other tabs).
 */
export const TerminalPanel = memo(function TerminalPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const terminalTabs = useAppStore((s) => s.terminalTabs);
  const activeTerminalTabId = useAppStore((s) =>
    s.selectedWorkspaceId ? s.activeTerminalTabId[s.selectedWorkspaceId] ?? null : null,
  );
  const setTerminalTabs = useAppStore((s) => s.setTerminalTabs);
  const addTerminalTab = useAppStore((s) => s.addTerminalTab);
  const removeTerminalTab = useAppStore((s) => s.removeTerminalTab);
  const setActiveTerminalTab = useAppStore((s) => s.setActiveTerminalTab);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const terminalPaneTrees = useAppStore((s) => s.terminalPaneTrees);
  const activeTerminalPaneId = useAppStore((s) => s.activeTerminalPaneId);
  const ensurePaneTree = useAppStore((s) => s.ensurePaneTree);
  const splitPane = useAppStore((s) => s.splitPane);
  const closePane = useAppStore((s) => s.closePane);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const setPaneSizes = useAppStore((s) => s.setPaneSizes);

  const autoCreatedRef = useRef<string | null>(null);
  const terminalTabsRef = useRef(terminalTabs);
  useEffect(() => {
    terminalTabsRef.current = terminalTabs;
  }, [terminalTabs]);
  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);
  const activeTerminalTabIdRef = useRef(activeTerminalTabId);
  useEffect(() => {
    activeTerminalTabIdRef.current = activeTerminalTabId;
  }, [activeTerminalTabId]);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const tabs = useMemo(
    () => (selectedWorkspaceId ? terminalTabs[selectedWorkspaceId] ?? [] : []),
    [selectedWorkspaceId, terminalTabs],
  );

  const handleCreateTab = useCallback(async () => {
    const wsId = selectedWorkspaceIdRef.current;
    if (!wsId) return;
    try {
      const tab = await createTerminalTab(wsId);
      addTerminalTab(wsId, tab);
    } catch (err) {
      console.error("Failed to create terminal tab:", err);
    }
  }, [addTerminalTab]);

  const cycleActiveTab = useCallback(
    (offset: 1 | -1) => {
      const wsId = selectedWorkspaceIdRef.current;
      if (!wsId) return;
      const wsTabs = terminalTabsRef.current[wsId] ?? [];
      const tabIds = wsTabs.map((t) => t.id);
      const nextId = cycleTabId(tabIds, activeTerminalTabIdRef.current, offset);
      if (nextId !== null) setActiveTerminalTab(wsId, nextId);
    },
    [setActiveTerminalTab],
  );

  const handleCloseTab = useCallback(
    async (tabId: number) => {
      if (!selectedWorkspaceId) return;
      try {
        await deleteTerminalTab(tabId);
        removeTerminalTab(selectedWorkspaceId, tabId);
      } catch (err) {
        console.error("Failed to close terminal tab:", err);
      }
    },
    [selectedWorkspaceId, removeTerminalTab],
  );

  // Load tabs on workspace + panel-visibility change. Same contract as before:
  // - only runs while the panel is visible, so closed panels don't auto-spawn
  // - auto-creates an initial tab if the workspace has none
  useEffect(() => {
    if (!selectedWorkspaceId || !terminalPanelVisible) return;
    const wsId = selectedWorkspaceId;
    listTerminalTabs(wsId).then(async (t) => {
      if (t.length > 0) {
        setTerminalTabs(wsId, t);
        const currentActive = useAppStore.getState().activeTerminalTabId[wsId];
        const activeStillValid =
          currentActive != null && t.some((tab) => tab.id === currentActive);
        if (!activeStillValid) {
          setActiveTerminalTab(wsId, t[0].id);
        }
      } else if (autoCreatedRef.current !== wsId) {
        autoCreatedRef.current = wsId;
        try {
          const tab = await createTerminalTab(wsId);
          addTerminalTab(wsId, tab);
        } catch {
          autoCreatedRef.current = null;
        }
      }
    });
  }, [
    selectedWorkspaceId,
    terminalPanelVisible,
    setTerminalTabs,
    setActiveTerminalTab,
    addTerminalTab,
  ]);

  // Ensure every tab in the current workspace has a pane tree. This is the
  // ephemeral counterpart to the DB-backed tab list: on app restart the
  // tabs come back but their panes have been torn down, so we rebuild each
  // tree as a single-leaf on demand.
  useEffect(() => {
    for (const tab of tabs) {
      ensurePaneTree(tab.id);
    }
  }, [tabs, ensurePaneTree]);

  // Build the shared xterm key handler once (via refs so it stays stable
  // across re-renders). Every TerminalLeaf installs it as its
  // attachCustomKeyEventHandler, so split/close/navigate shortcuts work
  // regardless of which pane has focus.
  const handleAction = useCallback(
    (action: Exclude<TerminalKeyAction, null>) => {
      const wsId = selectedWorkspaceIdRef.current;
      const tabId = activeTerminalTabIdRef.current;
      if (!wsId || !tabId) return;
      const state = useAppStore.getState();
      const activePaneId = state.activeTerminalPaneId[tabId] ?? null;

      switch (action.kind) {
        case "cycle":
          cycleActiveTab(action.direction === "next" ? 1 : -1);
          return;
        case "new-tab":
          void handleCreateTab();
          return;
        case "toggle-panel":
          useAppStore.getState().toggleTerminalPanel();
          requestAnimationFrame(() => {
            const visible = useAppStore.getState().terminalPanelVisible;
            if (visible) focusActiveTerminal();
            else focusChatPrompt();
          });
          return;
        case "focus-chat":
          focusChatPrompt();
          return;
        case "split-pane": {
          if (!activePaneId) return;
          splitPane(tabId, activePaneId, action.direction);
          return;
        }
        case "close-pane": {
          if (!activePaneId) return;
          const promoted = closePane(tabId, activePaneId);
          if (!promoted) {
            // Sole leaf — treat Cmd+W as close-tab.
            void handleCloseTab(tabId);
          }
          return;
        }
        case "focus-pane": {
          if (!activePaneId) return;
          const tree = state.terminalPaneTrees[tabId];
          if (!tree) return;
          const next = neighborLeaf(tree, activePaneId, action.direction);
          if (next) setActivePane(tabId, next);
          return;
        }
        case "zoom":
          // Handled by the global handler; we only suppress here.
          return;
      }
    },
    [
      cycleActiveTab,
      handleCloseTab,
      handleCreateTab,
      splitPane,
      closePane,
      setActivePane,
    ],
  );

  const keyHandler = useCallback(
    (ev: KeyboardEvent): boolean => {
      const action = terminalKeyAction(ev);
      if (!action) return true;
      ev.preventDefault();
      // Zoom is handled by the global listener; suppress PTY bytes but let
      // the event keep propagating.
      if (action.kind === "zoom") return false;
      ev.stopImmediatePropagation();
      handleAction(action);
      return false;
    },
    [handleAction],
  );

  const handleActivatePane = useCallback(
    (leafId: string) => {
      const tabId = activeTerminalTabIdRef.current;
      if (!tabId) return;
      setActivePane(tabId, leafId);
    },
    [setActivePane],
  );

  const handleLayout = useCallback(
    (splitId: string, sizes: [number, number]) => {
      const tabId = activeTerminalTabIdRef.current;
      if (!tabId) return;
      setPaneSizes(tabId, splitId, sizes);
    },
    [setPaneSizes],
  );

  return (
    <div className={styles.panel}>
      <div className={styles.tabBar}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`${styles.tab} ${activeTerminalTabId === tab.id ? styles.tabActive : ""}`}
            onClick={() =>
              selectedWorkspaceId && setActiveTerminalTab(selectedWorkspaceId, tab.id)
            }
          >
            <span className={styles.tabTitle}>{tab.title}</span>
            <button
              className={styles.tabClose}
              onClick={(e) => {
                e.stopPropagation();
                handleCloseTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className={styles.addTab} onClick={handleCreateTab}>
          +
        </button>
        <div className={styles.spacer} />
        <button className={styles.hideBtn} onClick={toggleTerminalPanel}>
          −
        </button>
      </div>
      <div className={styles.termContainer}>
        {tabs.map((tab) => {
          const tree = terminalPaneTrees[tab.id];
          // Tree may briefly be absent between tab creation and the
          // ensurePaneTree effect. Render nothing until it's ready — the
          // container's height is preserved by the parent's flex layout.
          if (!tree || !ws?.worktree_path) return null;
          const isActiveTab = tab.id === activeTerminalTabId;
          return (
            <div
              key={tab.id}
              className={styles.paneRoot}
              style={{ display: isActiveTab ? "block" : "none" }}
            >
              <TerminalPaneTree
                tabId={tab.id}
                workspaceId={ws.id}
                worktreePath={ws.worktree_path}
                node={tree}
                activePaneId={activeTerminalPaneId[tab.id] ?? null}
                keyHandler={keyHandler}
                onActivatePane={handleActivatePane}
                onLayout={handleLayout}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
