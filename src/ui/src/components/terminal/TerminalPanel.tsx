import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
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
import {
  cycleTabId,
  terminalKeyAction,
  type TerminalKeyAction,
} from "./terminalShortcuts";
import { countLeaves, neighborLeaf } from "../../stores/terminalPaneTree";
import { trimSelectionTrailingWhitespace } from "./terminalSelection";
import {
  focusActiveTerminal,
  focusChatPrompt,
} from "../../utils/focusTargets";
import { TerminalPaneTree } from "./TerminalPaneTree";
import {
  collectNeededLeaves,
  diffLeaves,
  type LeafInstanceSnapshot,
  type NeededLeaf,
} from "./terminalLeafManager";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalPanel.module.css";

interface PtyOutputPayload {
  pty_id: number;
  data: number[];
}

// Per-leaf xterm + PTY handle. The container is a detached <div> that we
// appendChild into whichever target div the pane tree currently emits for
// this leafId — that's the trick that keeps xterm alive across splits.
interface LeafInstance {
  leafId: string;
  tabId: number;
  workspaceId: string;
  worktreePath: string;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  ptyId: number;
  unlisten: (() => void) | null;
  resizeObserver: ResizeObserver;
  fitTimer: ReturnType<typeof setTimeout> | null;
  handleCopy: (ev: ClipboardEvent) => void;
  keyHandler: (ev: KeyboardEvent) => boolean;
}

function safeFit(inst: LeafInstance) {
  if (inst.container.clientHeight > 0 && inst.container.clientWidth > 0) {
    inst.fit.fit();
  }
}

function closePtyBestEffort(ptyId: number) {
  void closePty(ptyId).catch((err) => {
    console.error(`Failed to close PTY ${ptyId} during teardown:`, err);
  });
}

/**
 * TerminalPanel owns the xterm/PTY lifecycle for every pane across every
 * tab. The Zustand `terminalPaneTrees` map provides the layout; this
 * component reconciles instances against that layout.
 *
 * The xterm host divs are NOT children of any React-rendered component.
 * Each render, a useLayoutEffect walks the DOM, finds target divs emitted
 * by TerminalPaneTree (`[data-pane-target={leafId}]`), and appendChilds
 * the host into the right target. That means rewriting the tree (split,
 * close, reparent) does not destroy xterm — it just moves the host div to
 * a new target. The `terminalLeafManager.ts` module contains the pure
 * diff helpers that drive this, and its tests pin down the invariant that
 * a split never tears down an existing instance.
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
  const setPanePtyId = useAppStore((s) => s.setPanePtyId);
  const setPaneSpawnError = useAppStore((s) => s.setPaneSpawnError);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const fontFamilyMono = useAppStore((s) => s.fontFamilyMono);
  const currentThemeId = useAppStore((s) => s.currentThemeId);

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

  // Load tabs on workspace + panel-visibility change.
  useEffect(() => {
    if (!selectedWorkspaceId || !terminalPanelVisible) return;
    const wsId = selectedWorkspaceId;
    listTerminalTabs(wsId).then(async (t) => {
      if (t.length > 0) {
        setTerminalTabs(wsId, t);
        const currentActive = useAppStore.getState().activeTerminalTabId[wsId];
        const activeStillValid =
          currentActive != null && t.some((tab) => tab.id === currentActive);
        if (!activeStillValid) setActiveTerminalTab(wsId, t[0].id);
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

  // Ensure every tab has a pane tree (ephemeral counterpart to the DB tabs).
  useEffect(() => {
    for (const tab of tabs) ensurePaneTree(tab.id);
  }, [tabs, ensurePaneTree]);

  // --- imperative xterm/PTY instance management ---------------------------

  const instancesRef = useRef<Map<string, LeafInstance>>(new Map());

  // Stable "latest handler" reference for the key event handler. The
  // attachCustomKeyEventHandler closure captures this ref on instance
  // creation so the freshly-registered shortcuts keep firing even if
  // callbacks in this component identity-change between renders.
  const keyHandlerRef = useRef<(ev: KeyboardEvent) => boolean>(() => true);

  const handleActivatePane = useCallback(
    (leafId: string) => {
      const tabId = activeTerminalTabIdRef.current;
      if (!tabId) return;
      setActivePane(tabId, leafId);
    },
    [setActivePane],
  );

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
          if (promoted) return;
          // `closePane` returns null both for "this was the sole leaf"
          // (we should close the tab) AND for "no-op: tree missing or
          // stale activePaneId" (we should NOT close the tab). Only fall
          // through to close-tab when the tree genuinely has a single
          // leaf remaining — otherwise a stale id would silently nuke a
          // tab full of panes.
          const tree = state.terminalPaneTrees[tabId];
          if (tree && countLeaves(tree) === 1) void handleCloseTab(tabId);
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

  // Rebuild keyHandlerRef whenever handleAction changes — xterm's
  // attachCustomKeyEventHandler captures keyHandlerRef by closure, so this
  // is effectively zero-cost updating.
  useEffect(() => {
    keyHandlerRef.current = (ev: KeyboardEvent): boolean => {
      const action = terminalKeyAction(ev);
      if (!action) return true;
      ev.preventDefault();
      if (action.kind === "zoom") return false;
      ev.stopImmediatePropagation();
      handleAction(action);
      return false;
    };
  }, [handleAction]);

  const createInstance = useCallback(
    (spec: NeededLeaf): LeafInstance => {
      const container = document.createElement("div");
      container.style.width = "100%";
      container.style.height = "100%";

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

      const keyHandler = (ev: KeyboardEvent): boolean =>
        keyHandlerRef.current(ev);
      term.attachCustomKeyEventHandler(keyHandler);
      term.open(container);

      const handleCopy = (ev: ClipboardEvent) => {
        if (!term.hasSelection()) return;
        const { clipboardData } = ev;
        if (!clipboardData) return;
        ev.preventDefault();
        clipboardData.setData(
          "text/plain",
          trimSelectionTrailingWhitespace(term.getSelection()),
        );
      };
      container.addEventListener("copy", handleCopy);

      const inst: LeafInstance = {
        leafId: spec.leafId,
        tabId: spec.tabId,
        workspaceId: spec.workspaceId,
        worktreePath: spec.worktreePath,
        container,
        term,
        fit,
        ptyId: -1,
        unlisten: null,
        fitTimer: null,
        handleCopy,
        keyHandler,
        resizeObserver: new ResizeObserver(() => {
          // Resolve `this` via closure; filled in next line.
        }),
      };
      inst.resizeObserver = new ResizeObserver(() => {
        if (inst.fitTimer) clearTimeout(inst.fitTimer);
        inst.fitTimer = setTimeout(() => safeFit(inst), 150);
      });
      inst.resizeObserver.observe(container);

      // Spawn the PTY asynchronously. If the instance has been destroyed
      // by the time we resolve, close the PTY we just spawned and bail.
      (async () => {
        try {
          const state = useAppStore.getState();
          const currentWs = state.workspaces.find(
            (w) => w.id === spec.workspaceId,
          );
          const currentRepo = currentWs
            ? state.repositories.find((r) => r.id === currentWs.repository_id)
            : undefined;
          const defaults = state.defaultBranches;
          const ptyId = await spawnPty(
            spec.worktreePath,
            currentWs?.name ?? "",
            spec.workspaceId,
            currentRepo?.path ?? "",
            currentWs ? (defaults[currentWs.repository_id] ?? "main") : "main",
            currentWs?.branch_name ?? "",
          );
          const stillExists = instancesRef.current.get(spec.leafId);
          if (stillExists !== inst) {
            closePtyBestEffort(ptyId);
            return;
          }
          inst.ptyId = ptyId;
          setPanePtyId(spec.tabId, spec.leafId, ptyId);

          const unlistenFn = await listen<PtyOutputPayload>(
            "pty-output",
            (event) => {
              if (event.payload.pty_id === ptyId) {
                term.write(new Uint8Array(event.payload.data));
              }
            },
          );
          if (instancesRef.current.get(spec.leafId) !== inst) {
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
          console.error("Failed to spawn PTY:", e);
          const msg = e instanceof Error ? e.message : String(e);
          setPaneSpawnError(spec.tabId, spec.leafId, msg);
          // Leave the instance in place so the user's retry flow works —
          // only the xterm part exists right now; the Retry button
          // destroys and re-creates the instance.
        }
      })();

      return inst;
    },
    [setPanePtyId, setPaneSpawnError, terminalFontSize],
  );

  const destroyInstance = useCallback((leafId: string) => {
    const inst = instancesRef.current.get(leafId);
    if (!inst) return;
    if (inst.fitTimer) clearTimeout(inst.fitTimer);
    inst.resizeObserver.disconnect();
    inst.container.removeEventListener("copy", inst.handleCopy);
    inst.term.dispose();
    if (inst.unlisten) inst.unlisten();
    if (inst.ptyId >= 0) closePtyBestEffort(inst.ptyId);
    inst.container.remove();
    instancesRef.current.delete(leafId);
  }, []);

  // Reconcile instances against the tree + reparent containers. Runs
  // useLayoutEffect so the DOM mutation happens in the same frame as the
  // React render, avoiding a visible flicker.
  //
  // IMPORTANT: we collect needed leaves across EVERY workspace's tabs, not
  // just the currently-selected workspace. Otherwise switching workspaces
  // would diff the previous workspace's leaves out of `needed`, destroy
  // their instances, and close their PTYs — killing long-running commands
  // (dev server, tailing logs, etc). The target divs for other
  // workspaces' tabs are not currently rendered, so their containers sit
  // detached in memory; when the user switches back, the target divs
  // reappear and the reparent loop re-mounts them in the DOM.
  useLayoutEffect(() => {
    const tabSpecs: Array<{
      id: number;
      workspaceId: string;
      worktreePath: string;
    }> = [];
    for (const [wsId, wsTabs] of Object.entries(terminalTabs)) {
      const workspace = workspaces.find((w) => w.id === wsId);
      const worktreePath = workspace?.worktree_path;
      if (!worktreePath) continue;
      for (const tab of wsTabs) {
        tabSpecs.push({ id: tab.id, workspaceId: wsId, worktreePath });
      }
    }
    const needed = collectNeededLeaves(tabSpecs, terminalPaneTrees);

    // Build a snapshot map for diffLeaves so we stay out of the instance
    // map's imperative inner state.
    const snapshot = new Map<string, LeafInstanceSnapshot>();
    for (const [id, inst] of instancesRef.current) {
      snapshot.set(id, {
        leafId: id,
        tabId: inst.tabId,
        workspaceId: inst.workspaceId,
      });
    }
    const { toCreate, toDestroy } = diffLeaves(needed, snapshot);

    for (const leafId of toDestroy) destroyInstance(leafId);
    for (const spec of toCreate) {
      instancesRef.current.set(spec.leafId, createInstance(spec));
    }

    // Reparent each instance's container into its current target div.
    for (const spec of needed) {
      const inst = instancesRef.current.get(spec.leafId);
      if (!inst) continue;
      const selector = `[data-pane-target="${CSS.escape(spec.leafId)}"]`;
      const target = document.querySelector(selector) as HTMLElement | null;
      if (target && inst.container.parentElement !== target) {
        target.appendChild(inst.container);
        // The container may have gone from 0×0 to a real size — refit
        // immediately so the user doesn't see an 80×24 stub.
        safeFit(inst);
        if (inst.ptyId >= 0) {
          resizePty(inst.ptyId, inst.term.cols, inst.term.rows);
        }
      }
    }
  }, [terminalTabs, workspaces, terminalPaneTrees, createInstance, destroyInstance]);

  // Font / theme propagation across all live instances.
  useEffect(() => {
    for (const inst of instancesRef.current.values()) {
      inst.term.options.fontSize = terminalFontSize;
      safeFit(inst);
    }
  }, [terminalFontSize]);

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
  }, [currentThemeId, fontFamilyMono]);

  // Refit + focus on panel-visibility transitions.
  useEffect(() => {
    if (!terminalPanelVisible) return;
    const id = requestAnimationFrame(() => {
      for (const inst of instancesRef.current.values()) {
        safeFit(inst);
      }
      focusActiveTerminal();
    });
    return () => cancelAnimationFrame(id);
  }, [terminalPanelVisible, activeTerminalTabId]);

  // Destroy everything on unmount.
  useEffect(() => {
    const instances = instancesRef.current;
    return () => {
      for (const leafId of [...instances.keys()]) destroyInstance(leafId);
      instances.clear();
    };
  }, [destroyInstance]);

  const handleLayout = useCallback(
    (splitId: string, sizes: [number, number]) => {
      const tabId = activeTerminalTabIdRef.current;
      if (!tabId) return;
      setPaneSizes(tabId, splitId, sizes);
      // react-resizable-panels updates layout before emitting onLayoutChanged,
      // so the ResizeObserver on every affected container will fire and
      // debounce-fit. No immediate action required here.
    },
    [setPaneSizes],
  );

  const handleRetryLeaf = useCallback(
    (leafId: string) => {
      const tabId = activeTerminalTabIdRef.current;
      if (!tabId) return;
      setPaneSpawnError(tabId, leafId, null);
      // Tear the instance down so the next useLayoutEffect recreates it.
      destroyInstance(leafId);
      // Force a re-run of the reconciliation. Updating state via
      // setPaneSpawnError above already triggers a store change, so React
      // will rerun useLayoutEffect naturally.
    },
    [setPaneSpawnError, destroyInstance],
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
          if (!tree) return null;
          const isActiveTab = tab.id === activeTerminalTabId;
          return (
            <div
              key={tab.id}
              className={styles.paneRoot}
              style={{ display: isActiveTab ? "block" : "none" }}
            >
              <TerminalPaneTree
                tabId={tab.id}
                node={tree}
                activePaneId={activeTerminalPaneId[tab.id] ?? null}
                onActivatePane={handleActivatePane}
                onLayout={handleLayout}
                onRetryLeaf={handleRetryLeaf}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
