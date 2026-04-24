import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../stores/useAppStore";
import { getTerminalTheme } from "../../utils/theme";
import {
  createTerminalTab,
  deleteTerminalTab,
  listTerminalTabs,
  openUrl,
  spawnPty,
  writePty,
  resizePty,
  closePty,
} from "../../services/tauri";
import { cycleTabId, terminalKeyAction } from "./terminalShortcuts";
import { trimSelectionTrailingWhitespace } from "./terminalSelection";
import {
  focusActiveTerminal,
  focusChatPrompt,
} from "../../utils/focusTargets";
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
  fitTimer: ReturnType<typeof setTimeout> | null;
  workspaceId: string;
  worktreePath: string;
}

// Fit xterm only when its container has real dimensions. A hidden container
// (display: none on the panel, or an inactive tab) has clientHeight === 0,
// and calling fit() against it throws inside xterm.
function safeFit(inst: TermInstance) {
  if (inst.container.clientHeight > 0 && inst.container.clientWidth > 0) {
    inst.fit.fit();
  }
}

function safeFitRaw(container: HTMLElement, fit: FitAddon) {
  if (container.clientHeight > 0 && container.clientWidth > 0) fit.fit();
}

// `closePty` is a Tauri invoke that returns a Promise<void>. Teardown
// paths don't await it (we don't want close to block tab-switching or
// unmount), so we need a centralized error sink; otherwise a failed close
// would surface as an unhandled promise rejection in the webview console.
// Failures here are best-effort by design — if the backend has already
// dropped the PTY (e.g. child exited, state race), there's nothing more
// we can do from the frontend.
function closePtyBestEffort(ptyId: number) {
  void closePty(ptyId).catch((err) => {
    console.error(`Failed to close PTY ${ptyId} during teardown:`, err);
  });
}

export const TerminalPanel = memo(function TerminalPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const terminalTabs = useAppStore((s) => s.terminalTabs);
  // Workspace-scoped active tab. Read through the selector so each workspace
  // preserves its own active tab independently.
  const activeTerminalTabId = useAppStore((s) =>
    s.selectedWorkspaceId ? s.activeTerminalTabId[s.selectedWorkspaceId] ?? null : null,
  );
  const setTerminalTabs = useAppStore((s) => s.setTerminalTabs);
  const addTerminalTab = useAppStore((s) => s.addTerminalTab);
  const removeTerminalTab = useAppStore((s) => s.removeTerminalTab);
  const setActiveTerminalTab = useAppStore((s) => s.setActiveTerminalTab);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const fontFamilyMono = useAppStore((s) => s.fontFamilyMono);
  const currentThemeId = useAppStore((s) => s.currentThemeId);
  const updateTerminalTabPtyId = useAppStore((s) => s.updateTerminalTabPtyId);

  const autoCreatedRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Map of tab ID → terminal instance. Persists across tab switches AND
  // across terminal-panel collapse/restore (the panel no longer unmounts).
  const instancesRef = useRef<Map<number, TermInstance>>(new Map());
  // Per-tab spawn-error messages; UI-only, ephemeral — not persisted.
  const [spawnErrors, setSpawnErrors] = useState<Record<number, string>>({});

  // Keep a live ref to the tabs-by-workspace map so the stable xterm key
  // handler can read the latest value without being re-created per render.
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

  // Destroy a single instance: dispose xterm, unlisten, close PTY, detach DOM.
  // Used by per-tab close AND by the tabs-no-longer-exist cleanup effect.
  const destroyInstance = useCallback((tabId: number) => {
    const inst = instancesRef.current.get(tabId);
    if (!inst) return;
    if (inst.fitTimer) clearTimeout(inst.fitTimer);
    inst.resizeObserver.disconnect();
    inst.term.dispose();
    if (inst.unlisten) inst.unlisten();
    if (inst.ptyId >= 0) closePtyBestEffort(inst.ptyId);
    inst.container.remove();
    instancesRef.current.delete(tabId);
  }, []);

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

  // Load terminal tabs on workspace change — but ONLY while the panel is
  // visible. Skipping this while hidden preserves two important properties:
  //   1. Selecting a workspace the user explicitly collapsed the panel on
  //      doesn't auto-create a tab, which would flip terminalPanelVisible
  //      back to true via addTerminalTab and reopen the panel uninvited.
  //   2. DB-backed tab creation (and future remote-workspace failures) is
  //      deferred until the user actually wants a terminal.
  // When the user later opens the panel, this effect re-runs (terminalPanel-
  // Visible is in its deps) and bootstraps the workspace's tabs on demand.
  useEffect(() => {
    if (!selectedWorkspaceId || !terminalPanelVisible) return;
    const wsId = selectedWorkspaceId;
    listTerminalTabs(wsId).then(async (t) => {
      if (t.length > 0) {
        setTerminalTabs(wsId, t);
        // Initialize this workspace's active tab if it has none, OR if the
        // stored active id is stale (the tab was deleted elsewhere — e.g.
        // another app instance, or a DB cascade we weren't notified of).
        // Otherwise the visibility effect would show no tab at all.
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

  // Create the xterm instance for the active tab, spawn the PTY, wire I/O.
  // Extracted as a function so we can re-run it from the spawn-error Retry
  // button without tearing down and recreating the whole component.
  const initializeTab = useCallback(
    (tabId: number, worktreePath: string, workspaceId: string) => {
      if (!containerRef.current) return;
      if (instancesRef.current.has(tabId)) return;

      const tabContainer = document.createElement("div");
      tabContainer.style.height = "100%";
      tabContainer.style.width = "100%";
      containerRef.current.appendChild(tabContainer);

      const monoFont =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono")
          .trim() || "monospace";
      const term = new Terminal({
        fontSize: terminalFontSize,
        fontFamily: monoFont,
        theme: getTerminalTheme(),
      });
      const fit = new FitAddon();
      const links = new WebLinksAddon((_event, url) => {
        void openUrl(url);
      });
      term.loadAddon(fit);
      term.loadAddon(links);

      // Intercept terminal-scoped hotkeys BEFORE xterm forwards the key to
      // the PTY. Returning false from this handler tells xterm not to send
      // bytes, and stopImmediatePropagation prevents the window-level
      // handler in useKeyboardShortcuts.ts from ALSO firing (which would
      // otherwise cycle workspaces on Cmd+Shift+[/]).
      term.attachCustomKeyEventHandler((ev) => {
        const action = terminalKeyAction(ev);
        if (!action) return true;
        ev.preventDefault();
        // Zoom actions suppress PTY bytes but must NOT stop propagation —
        // the global handler in useKeyboardShortcuts.ts processes the zoom.
        if (action.kind === "zoom") return false;
        ev.stopImmediatePropagation();
        if (action.kind === "cycle") {
          cycleActiveTab(action.direction === "next" ? 1 : -1);
        } else if (action.kind === "new-tab") {
          void handleCreateTab();
        } else if (action.kind === "toggle-panel") {
          // Cmd+` — hide panel and move focus to the chat prompt. The
          // shells keep running (the panel is CSS-hidden, not unmounted).
          useAppStore.getState().toggleTerminalPanel();
          requestAnimationFrame(() => {
            const visible = useAppStore.getState().terminalPanelVisible;
            if (visible) focusActiveTerminal();
            else focusChatPrompt();
          });
        } else if (action.kind === "focus-chat") {
          // Cmd+0 — focus the chat prompt; leave the terminal visible.
          focusChatPrompt();
        }
        return false;
      });

      term.open(tabContainer);
      safeFitRaw(tabContainer, fit);

      // Rewrite the clipboard payload on copy to rstrip trailing whitespace
      // per line. xterm.js renders on a fixed cell grid, so a selection that
      // sweeps short lines includes the blank trailing cells as spaces;
      // native macOS terminals trim those at copy time and so do we.
      const handleCopy = (ev: ClipboardEvent) => {
        if (!term.hasSelection()) return;
        ev.preventDefault();
        ev.clipboardData?.setData(
          "text/plain",
          trimSelectionTrailingWhitespace(term.getSelection()),
        );
      };
      tabContainer.addEventListener("copy", handleCopy);

      const instance: TermInstance = {
        term,
        fit,
        ptyId: -1,
        unlisten: null,
        container: tabContainer,
        fitTimer: null,
        workspaceId,
        worktreePath,
        // The observer debounces resizes to 150ms and skips fits when the
        // container has no real dimensions (e.g. the panel is hidden).
        resizeObserver: new ResizeObserver(() => {
          if (instance.fitTimer) clearTimeout(instance.fitTimer);
          instance.fitTimer = setTimeout(() => safeFit(instance), 150);
        }),
      };
      instance.resizeObserver.observe(tabContainer);
      instancesRef.current.set(tabId, instance);

      (async () => {
        try {
          const currentWs = useAppStore.getState().workspaces.find((w) => w.id === workspaceId);
          const currentRepo = currentWs
            ? useAppStore.getState().repositories.find((r) => r.id === currentWs.repository_id)
            : undefined;
          const currentDefaultBranches = useAppStore.getState().defaultBranches;
          const ptyId = await spawnPty(
            worktreePath,
            currentWs?.name ?? "",
            workspaceId,
            currentRepo?.path ?? "",
            currentWs ? (currentDefaultBranches[currentWs.repository_id] ?? "main") : "main",
            currentWs?.branch_name ?? "",
          );
          const inst = instancesRef.current.get(tabId);
          if (!inst) {
            closePtyBestEffort(ptyId);
            return;
          }
          inst.ptyId = ptyId;

          updateTerminalTabPtyId(tabId, ptyId);

          const unlistenFn = await listen<PtyOutputPayload>(
            "pty-output",
            (event) => {
              if (event.payload.pty_id === ptyId) {
                term.write(new Uint8Array(event.payload.data));
              }
            },
          );
          const stillExists = instancesRef.current.get(tabId);
          if (!stillExists || stillExists !== inst) {
            unlistenFn();
            closePtyBestEffort(ptyId);
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

          safeFit(inst);
          resizePty(ptyId, term.cols, term.rows);
        } catch (e) {
          // Keep the tab around (don't delete the user's tab just because
          // spawn failed); surface the error inline with a Retry button.
          console.error("Failed to initialize terminal:", e);
          destroyInstance(tabId);
          setSpawnErrors((prev) => ({
            ...prev,
            [tabId]: e instanceof Error ? e.message : String(e),
          }));
        }
      })();
    },
    [
      cycleActiveTab,
      destroyInstance,
      handleCreateTab,
      terminalFontSize,
      updateTerminalTabPtyId,
    ],
  );

  // Spawn instances as tabs become active. Unlike before, this does NOT run
  // when the panel is toggled (the panel doesn't unmount anymore), so the
  // xterm + PTY only get set up once per tab, and survive collapse/restore.
  useEffect(() => {
    if (!containerRef.current || !ws?.worktree_path || !activeTerminalTabId) return;
    if (instancesRef.current.has(activeTerminalTabId)) return;
    // Don't re-spawn tabs that have an active spawn error banner — the user
    // must click Retry, which clears the error and calls us again.
    if (spawnErrors[activeTerminalTabId]) return;
    initializeTab(activeTerminalTabId, ws.worktree_path, ws.id);
  }, [activeTerminalTabId, ws?.worktree_path, ws?.id, initializeTab, spawnErrors]);

  // Show/hide terminal containers based on active tab and selected workspace.
  // Instances for non-current workspaces stay in the DOM (display: none) so
  // their shells keep running while the user is elsewhere in the app.
  useEffect(() => {
    const currentWorkspaceTabIds = new Set(tabs.map((t) => t.id));
    for (const [tabId, inst] of instancesRef.current) {
      const belongsToCurrentWorkspace = currentWorkspaceTabIds.has(tabId);
      const isActive = tabId === activeTerminalTabId && belongsToCurrentWorkspace;
      inst.container.style.display = isActive ? "block" : "none";
      if (isActive) {
        safeFit(inst);
        inst.term.focus();
      }
    }
  }, [activeTerminalTabId, tabs]);

  // Re-fit the active instance when the panel transitions hidden → visible.
  // xterm doesn't know the container grew from 0×0 to real dimensions, so
  // without this the terminal keeps its old (possibly 80×24) geometry.
  useEffect(() => {
    if (!terminalPanelVisible || !activeTerminalTabId) return;
    const inst = instancesRef.current.get(activeTerminalTabId);
    if (!inst) return;
    // Run after layout so clientHeight reflects the restored panel.
    const id = requestAnimationFrame(() => {
      safeFit(inst);
      if (inst.ptyId >= 0) {
        resizePty(inst.ptyId, inst.term.cols, inst.term.rows);
      }
      inst.term.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [terminalPanelVisible, activeTerminalTabId]);

  // Update font size on all instances without destroying them.
  useEffect(() => {
    for (const inst of instancesRef.current.values()) {
      inst.term.options.fontSize = terminalFontSize;
      safeFit(inst);
    }
  }, [terminalFontSize]);

  // Update terminal theme and font on all instances when the app theme changes.
  useEffect(() => {
    const theme = getTerminalTheme();
    const monoFont =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim() || "monospace";
    for (const inst of instancesRef.current.values()) {
      inst.term.options.theme = theme;
      inst.term.options.fontFamily = monoFont;
      safeFit(inst);
    }
  }, [currentThemeId]);

  // Update terminal font family when user changes monospace font preference.
  useEffect(() => {
    const monoFont =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim() || "monospace";
    for (const inst of instancesRef.current.values()) {
      inst.term.options.fontFamily = monoFont;
      safeFit(inst);
    }
  }, [fontFamilyMono]);

  // Cleanup instances for tabs that no longer exist in any workspace. This
  // covers BOTH per-tab close (removeTerminalTab) AND workspace deletion
  // (removeWorkspace / removeRepository in the store drops the workspace's
  // `terminalTabs` entry, which removes all its tab ids from this set).
  useEffect(() => {
    const allTabIds = new Set(
      Object.values(terminalTabs).flatMap((wsTabs) => wsTabs.map((t) => t.id)),
    );
    // Snapshot keys — destroyInstance mutates the map.
    for (const tabId of [...instancesRef.current.keys()]) {
      if (!allTabIds.has(tabId)) destroyInstance(tabId);
    }
    // Also clear any spawn-error entries for tabs that have disappeared.
    setSpawnErrors((prev) => {
      const next: Record<number, string> = {};
      let changed = false;
      for (const [idStr, msg] of Object.entries(prev)) {
        const id = Number(idStr);
        if (allTabIds.has(id)) next[id] = msg;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [terminalTabs, destroyInstance]);

  // Cleanup all instances on component unmount only. Snapshot the keys first
  // because `destroyInstance` mutates the map during iteration.
  useEffect(() => {
    const instances = instancesRef.current;
    return () => {
      for (const tabId of [...instances.keys()]) destroyInstance(tabId);
      instances.clear();
    };
  }, [destroyInstance]);

  const handleCloseTab = useCallback(
    async (tabId: number) => {
      if (!selectedWorkspaceId) return;
      destroyInstance(tabId);
      try {
        await deleteTerminalTab(tabId);
        removeTerminalTab(selectedWorkspaceId, tabId);
      } catch (err) {
        console.error("Failed to close terminal tab:", err);
      }
    },
    [selectedWorkspaceId, removeTerminalTab, destroyInstance],
  );

  const handleRetrySpawn = useCallback(
    (tabId: number) => {
      if (!ws?.worktree_path || !selectedWorkspaceId) return;
      setSpawnErrors((prev) => {
        const { [tabId]: _removed, ...rest } = prev;
        return rest;
      });
      // Call directly; the spawn effect will also re-run because
      // `spawnErrors[tabId]` just cleared, but initializeTab is idempotent
      // (it bails if an instance already exists).
      initializeTab(tabId, ws.worktree_path, selectedWorkspaceId);
    },
    [ws?.worktree_path, selectedWorkspaceId, initializeTab],
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
      <div className={styles.termContainer} ref={containerRef}>
        {activeTerminalTabId !== null && spawnErrors[activeTerminalTabId] && (
          <div className={styles.spawnError} role="alert">
            <div className={styles.spawnErrorTitle}>Failed to start shell</div>
            <div className={styles.spawnErrorMessage}>
              {spawnErrors[activeTerminalTabId]}
            </div>
            <button
              className={styles.spawnErrorRetry}
              onClick={() => handleRetrySpawn(activeTerminalTabId)}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

