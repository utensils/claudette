import { useCallback, useEffect, useRef } from "react";
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

export function TerminalPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const terminalTabs = useAppStore((s) => s.terminalTabs);
  const activeTerminalTabId = useAppStore((s) => s.activeTerminalTabId);
  const setTerminalTabs = useAppStore((s) => s.setTerminalTabs);
  const addTerminalTab = useAppStore((s) => s.addTerminalTab);
  const removeTerminalTab = useAppStore((s) => s.removeTerminalTab);
  const setActiveTerminalTab = useAppStore((s) => s.setActiveTerminalTab);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);

  const autoCreatedRef = useRef<string | null>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const tabs = selectedWorkspaceId
    ? terminalTabs[selectedWorkspaceId] || []
    : [];

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

  // Initialize xterm and PTY
  useEffect(() => {
    if (!termRef.current || !ws?.worktree_path || !activeTerminalTabId) return;

    const term = new Terminal({
      fontSize: 13,
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
    term.open(termRef.current);
    fit.fit();

    xtermRef.current = term;
    fitRef.current = fit;

    let ptyId: number | null = null;
    let unlisten: (() => void) | null = null;

    (async () => {
      ptyId = await spawnPty(ws.worktree_path!);
      ptyIdRef.current = ptyId;

      const currentPtyId = ptyId;
      const unlistenFn = await listen<PtyOutputPayload>(
        "pty-output",
        (event) => {
          if (event.payload.pty_id === currentPtyId) {
            term.write(new Uint8Array(event.payload.data));
          }
        }
      );
      unlisten = unlistenFn;

      term.onData((data) => {
        const bytes = Array.from(new TextEncoder().encode(data));
        writePty(currentPtyId, bytes);
      });

      term.onResize(({ cols, rows }) => {
        resizePty(currentPtyId, cols, rows);
      });

      // Initial resize after PTY is ready
      fit.fit();
      resizePty(currentPtyId, term.cols, term.rows);
    })();

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
    });
    resizeObserver.observe(termRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      if (unlisten) unlisten();
      if (ptyId !== null) {
        closePty(ptyId);
        ptyIdRef.current = null;
      }
    };
  }, [activeTerminalTabId, ws?.worktree_path]);

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
      <div className={styles.termContainer} ref={termRef} />
    </div>
  );
}
