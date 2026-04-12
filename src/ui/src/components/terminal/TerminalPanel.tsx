import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../stores/useAppStore";
import {
  createTerminalTab,
  deleteTerminalTab,
  listTerminalTabs,
  spawnPty,
  writePty,
  resizePty,
  closePty,
} from "../../services/tauri";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalPanel.module.css";

interface PtyOutputPayload {
  pty_id: number;
  data: number[];
}

interface TermInstance {
  term: Terminal;
  fit: FitAddon;
  ptyId: number;
  unlisten: (() => void) | null;
  container: HTMLDivElement;
  resizeObserver: ResizeObserver;
}

export const TerminalPanel = memo(function TerminalPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const terminalTabs = useAppStore((s) => s.terminalTabs);
  const activeTerminalTabId = useAppStore((s) => s.activeTerminalTabId);
  const setTerminalTabs = useAppStore((s) => s.setTerminalTabs);
  const addTerminalTab = useAppStore((s) => s.addTerminalTab);
  const removeTerminalTab = useAppStore((s) => s.removeTerminalTab);
  const setActiveTerminalTab = useAppStore((s) => s.setActiveTerminalTab);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const updateTerminalTabPtyId = useAppStore((s) => s.updateTerminalTabPtyId);

  const autoCreatedRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Map of tab ID → terminal instance. Persists across tab switches.
  const instancesRef = useRef<Map<number, TermInstance>>(new Map());

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const tabs = useMemo(
    () => (selectedWorkspaceId ? terminalTabs[selectedWorkspaceId] ?? [] : []),
    [selectedWorkspaceId, terminalTabs]
  );

  // Load terminal tabs on workspace change; auto-create one if none exist.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    listTerminalTabs(selectedWorkspaceId).then(async (t) => {
      if (t.length > 0) {
        setTerminalTabs(selectedWorkspaceId, t);
        if (!activeTerminalTabId) {
          setActiveTerminalTab(t[0].id);
        }
      } else if (autoCreatedRef.current !== selectedWorkspaceId) {
        autoCreatedRef.current = selectedWorkspaceId;
        try {
          const tab = await createTerminalTab(selectedWorkspaceId);
          addTerminalTab(selectedWorkspaceId, tab);
        } catch {
          autoCreatedRef.current = null;
        }
      }
    });
  }, [
    selectedWorkspaceId,
    setTerminalTabs,
    setActiveTerminalTab,
    addTerminalTab,
    activeTerminalTabId,
  ]);

  // Ensure activeTerminalTabId belongs to the current workspace.
  useEffect(() => {
    if (!selectedWorkspaceId || tabs.length === 0) return;
    const tabIds = tabs.map((t) => t.id);
    if (activeTerminalTabId && !tabIds.includes(activeTerminalTabId)) {
      setActiveTerminalTab(tabs[0].id);
    }
  }, [selectedWorkspaceId, tabs, activeTerminalTabId, setActiveTerminalTab]);

  // Create a terminal instance for a tab if it doesn't exist yet.
  useEffect(() => {
    if (
      !containerRef.current ||
      !ws?.worktree_path ||
      !activeTerminalTabId ||
      instancesRef.current.has(activeTerminalTabId)
    ) {
      return;
    }

    const tabContainer = document.createElement("div");
    tabContainer.style.height = "100%";
    tabContainer.style.width = "100%";
    containerRef.current.appendChild(tabContainer);

    const term = new Terminal({
      fontSize: terminalFontSize,
      fontFamily: "monospace",
      theme: {
        background: "#121216",
        foreground: "#e6e6eb",
        cursor: "#e6e6eb",
      },
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(tabContainer);
    fit.fit();

    let fitTimer: ReturnType<typeof setTimeout>;
    const instance: TermInstance = {
      term,
      fit,
      ptyId: -1,
      unlisten: null,
      container: tabContainer,
      resizeObserver: new ResizeObserver(() => {
        clearTimeout(fitTimer);
        fitTimer = setTimeout(() => fit.fit(), 150);
      }),
    };
    instance.resizeObserver.observe(tabContainer);
    instancesRef.current.set(activeTerminalTabId, instance);

    const currentTabId = activeTerminalTabId;
    const worktreePath = ws.worktree_path!;

    (async () => {
      try {
        const ptyId = await spawnPty(worktreePath);
        // Re-check: instance may have been removed during await.
        const inst = instancesRef.current.get(currentTabId);
        if (!inst) {
          closePty(ptyId);
          return;
        }
        inst.ptyId = ptyId;

        // Store pty_id on the tab so we can map command events back to workspaces
        updateTerminalTabPtyId(currentTabId, ptyId);

        const unlistenFn = await listen<PtyOutputPayload>(
          "pty-output",
          (event) => {
            if (event.payload.pty_id === ptyId) {
              term.write(new Uint8Array(event.payload.data));
            }
          }
        );
        // Re-check again: instance may have been removed during listen await.
        const stillExists = instancesRef.current.get(currentTabId);
        if (!stillExists || stillExists !== inst) {
          unlistenFn();
          closePty(ptyId);
          return;
        }
        inst.unlisten = unlistenFn;

        term.onData((data) => {
          const bytes = Array.from(new TextEncoder().encode(data));
          writePty(ptyId, bytes);
        });

        term.onResize(({ cols, rows }) => {
          resizePty(ptyId, cols, rows);
        });

        fit.fit();
        resizePty(ptyId, term.cols, term.rows);
      } catch (e) {
        // Setup failed — clean up the orphaned instance.
        console.error("Failed to initialize terminal:", e);
        const inst = instancesRef.current.get(currentTabId);
        if (inst) {
          inst.resizeObserver.disconnect();
          inst.term.dispose();
          inst.container.remove();
          instancesRef.current.delete(currentTabId);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTerminalTabId, ws?.worktree_path]);

  // Show/hide terminal containers based on active tab and selected workspace.
  useEffect(() => {
    const currentWorkspaceTabIds = new Set(tabs.map((t) => t.id));
    for (const [tabId, inst] of instancesRef.current) {
      const belongsToCurrentWorkspace = currentWorkspaceTabIds.has(tabId);
      const isActive = tabId === activeTerminalTabId && belongsToCurrentWorkspace;
      inst.container.style.display = isActive ? "block" : "none";
      if (isActive) {
        inst.fit.fit();
        inst.term.focus();
      }
    }
  }, [activeTerminalTabId, tabs]);

  // Update font size on all instances without destroying them.
  useEffect(() => {
    for (const inst of instancesRef.current.values()) {
      inst.term.options.fontSize = terminalFontSize;
      inst.fit.fit();
    }
  }, [terminalFontSize]);

  // Cleanup instances for tabs that no longer exist in any workspace.
  useEffect(() => {
    const allTabIds = new Set(
      Object.values(terminalTabs).flatMap((tabs) => tabs.map((t) => t.id))
    );
    for (const [tabId, inst] of instancesRef.current) {
      if (!allTabIds.has(tabId)) {
        inst.resizeObserver.disconnect();
        inst.term.dispose();
        if (inst.unlisten) inst.unlisten();
        if (inst.ptyId >= 0) closePty(inst.ptyId);
        inst.container.remove();
        instancesRef.current.delete(tabId);
      }
    }
  }, [terminalTabs]);

  // Cleanup all instances on component unmount only.
  useEffect(() => {
    return () => {
      for (const inst of instancesRef.current.values()) {
        inst.resizeObserver.disconnect();
        inst.term.dispose();
        if (inst.unlisten) inst.unlisten();
        if (inst.ptyId >= 0) closePty(inst.ptyId);
        inst.container.remove();
      }
      instancesRef.current.clear();
    };
  }, []);

  const handleCreateTab = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    try {
      const tab = await createTerminalTab(selectedWorkspaceId);
      addTerminalTab(selectedWorkspaceId, tab);
    } catch {
      // ignore
    }
  }, [selectedWorkspaceId, addTerminalTab]);

  const handleCloseTab = useCallback(
    async (tabId: number) => {
      if (!selectedWorkspaceId) return;
      // Destroy the instance for this tab.
      const inst = instancesRef.current.get(tabId);
      if (inst) {
        inst.resizeObserver.disconnect();
        inst.term.dispose();
        if (inst.unlisten) inst.unlisten();
        if (inst.ptyId >= 0) closePty(inst.ptyId);
        inst.container.remove();
        instancesRef.current.delete(tabId);
      }
      try {
        await deleteTerminalTab(tabId);
        removeTerminalTab(selectedWorkspaceId, tabId);
      } catch {
        // ignore
      }
    },
    [selectedWorkspaceId, removeTerminalTab]
  );

  return (
    <div className={styles.panel}>
      <div className={styles.tabBar}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`${styles.tab} ${activeTerminalTabId === tab.id ? styles.tabActive : ""}`}
            onClick={() => setActiveTerminalTab(tab.id)}
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
      <div className={styles.termContainer} ref={containerRef} />
    </div>
  );
});
