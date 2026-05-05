import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../stores/useAppStore";
import { getTerminalTheme } from "../../utils/theme";
import {
  createTerminalTab,
  deleteTerminalTab,
  ensureClaudetteTerminalTab,
  listTerminalTabs,
  updateTerminalTabOrder,
  openUrl,
  spawnPty,
  writePty,
  resizePty,
  closePty,
  startAgentTaskTail,
  stopAgentTaskTail,
  stopAgentBackgroundTask,
} from "../../services/tauri";
import {
  cycleTabId,
  shouldStopTerminalEventPropagation,
  terminalKeyAction,
  type TerminalKeyAction,
} from "./terminalShortcuts";
import {
  countLeaves,
  neighborLeaf,
  shouldFocusLeaf,
} from "../../stores/terminalPaneTree";
import { trimSelectionTrailingWhitespace } from "./terminalSelection";
import {
  focusActiveTerminal,
  focusChatPrompt,
} from "../../utils/focusTargets";
import { TerminalPaneTree } from "./TerminalPaneTree";
import type { TerminalTab } from "../../types/terminal";
import {
  collectNeededLeaves,
  diffLeaves,
  type LeafInstanceSnapshot,
  type NeededLeaf,
} from "./terminalLeafManager";
import {
  shouldForwardPtyResize,
  type PtySizeSnapshot,
} from "./terminalPtyResize";
import {
  reorderTerminalTabs,
  tabDropPlacement,
  type TabDropPlacement,
} from "./terminalPanelLogic";
import {
  AttachmentContextMenu,
  type AttachmentContextMenuItem,
} from "../chat/AttachmentContextMenu";
import { viewportToFixed } from "../../utils/zoom";
import { reclaimScrollLines } from "./terminalReclaim";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalPanel.module.css";

interface PtyOutputPayload {
  pty_id: number;
  data: number[];
}

interface AgentTaskOutputPayload {
  tab_id: number;
  data: number[];
  reset?: boolean;
}

const terminalInputEncoder = new TextEncoder();
const terminalContextMenuOptions = { capture: true };

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
  isAgentTask: boolean;
  agentTaskTailPath: string | null;
  unlisten: (() => void) | null;
  resizeObserver: ResizeObserver;
  fitTimer: ReturnType<typeof setTimeout> | null;
  reclaimTimer: ReturnType<typeof setTimeout> | null;
  reclaimDisposer: (() => void) | null;
  handleCopy: (ev: ClipboardEvent) => void;
  handleContextMenu: (ev: MouseEvent) => void;
  keyHandler: (ev: KeyboardEvent) => boolean;
  lastPtySize: PtySizeSnapshot | null;
}

function safeFit(inst: LeafInstance) {
  if (inst.container.clientHeight > 0 && inst.container.clientWidth > 0) {
    inst.fit.fit();
  }
}

// Claudette scales the whole UI by setting `zoom` on <html> (theme.ts ::
// applyUserFonts). xterm.js measures cell height with `offsetHeight`
// (layout pixels, unzoomed) but mouse events and getBoundingClientRect
// return zoomed pixels — every click is then off by the zoom factor and
// selection / WebLinksAddon hits land on the wrong row (issue 547).
//
// Fix: undo the page zoom on the terminal container so xterm's subtree
// runs at 1:1 between layout and viewport coords, then bump the xterm
// font-size by the same factor so the terminal still renders at the
// user's chosen visual size. Returns 1 when no zoom is set, in which
// case the helpers below are no-ops.
function getRootZoom(): number {
  const z = parseFloat(document.documentElement.style.zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function applyZoomCompensation(inst: LeafInstance, rootZoom: number, baseFontSize: number) {
  inst.container.style.zoom = rootZoom === 1 ? "" : String(1 / rootZoom);
  inst.term.options.fontSize = baseFontSize * rootZoom;
}

// A split triggers SIGWINCH on the underlying PTY; many shells (zsh + zle's
// `reset-prompt`, p10k, starship's zle-line-init, etc.) respond by moving the
// cursor to (0,0) and emitting `\e[J`, which clears the visible viewport and
// redraws the prompt at the top. Scrollback is preserved, but the user sees
// an empty pane with a lone prompt at the top — which reads as "the split
// truncated my output".
//
// We can't stop the shell from doing that, but we can compensate after the
// fact: once the redraw has settled, if the cursor landed high in the
// viewport while scrollback exists below the visible window, scroll the
// display up so the cursor sits near the bottom of the viewport and the
// preceding history is visible again.
// One-stop helper for the "scroll the display immediately, not on the next
// animation frame" path we need after a split-driven reparent. The public
// `Terminal.scrollLines` API dispatches through xterm's viewport smooth-scroll
// animator; when the host div has just been re-attached to a different parent
// the viewport's scrollable element isn't fully laid out yet and the call is
// swallowed without moving `buffer.ydisp`. `_core._bufferService.scrollLines`
// mutates `ydisp` synchronously, which is the behaviour we actually want.
//
// `_core` is a private implementation detail of xterm. It has been stable
// across the 5.x line (see `xterm/src/common/services/BufferService.ts`), but
// is not part of the published API and may move on a major xterm upgrade.
// This single helper is the only place that reaches into `_core`; if it ever
// breaks, the fallback below keeps behaviour correct (just not synchronous)
// until we wire up a public-API alternative.
interface XtermInternals {
  _core?: {
    _bufferService?: {
      scrollLines(disp: number, suppressScrollEvent?: boolean): void;
    };
  };
}

function scrollLinesImmediate(term: Terminal, lines: number): void {
  const bs = (term as unknown as XtermInternals)._core?._bufferService;
  if (bs) bs.scrollLines(lines);
  else term.scrollLines(lines);
}

// Push the current visible rows into scrollback by writing newlines
// directly to the xterm buffer. Why: when a pane is resized the shell
// gets SIGWINCH and its prompt-redraw handler (zle `reset-prompt`,
// powerlevel10k, starship's equivalent) typically emits \e[H\e[J —
// cursor home then erase-to-end-of-display. Per VT spec, xterm erases
// those visible rows in place and does NOT copy them to scrollback, so
// everything the user was looking at a moment ago is destroyed. By
// injecting blank lines ahead of the shell's redraw we make the erase
// target a freshly-blank viewport while the real content slides safely
// up into scrollback. The injection is synchronous inside
// useLayoutEffect, whereas the shell's response arrives via an async
// pty-output event — so the ordering is guaranteed.
//
// Two subtleties that matter for UX:
//   - Only preserve the rows that actually have content. A pane whose
//     viewport is mostly blank (e.g., right after a previous split
//     where the shell has only re-drawn its prompt at the top) would
//     otherwise have a full viewport's worth of blanks appended to
//     scrollback on every split — scrollback bloat the user perceives
//     as "extra spaces with each further split".
//   - Don't push the cursor's own row (the shell's current prompt
//     line) into scrollback. The shell will redraw the prompt at the
//     new viewport's top on SIGWINCH; if we leave the current prompt
//     row in place at new viewport row 0 the redraw overwrites it
//     cleanly, rather than leaving the pre-split prompt stranded in
//     scrollback as a duplicate immediately above the new one.
function padViewportIntoScrollback(inst: LeafInstance) {
  const rows = inst.term.rows;
  if (rows <= 0) return;
  const buf = inst.term.buffer.active;
  // Walk the viewport bottom-up to find the last row with any
  // non-whitespace content. Everything from row 0 through that row is
  // what we need to preserve; rows below are already blank and the
  // shell's \e[J will erase them without data loss.
  let lastContentY = -1;
  for (let y = rows - 1; y >= 0; y--) {
    const line = buf.getLine(buf.baseY + y);
    if (line && line.translateToString(true).length > 0) {
      lastContentY = y;
      break;
    }
  }
  if (lastContentY < 0) return;
  // Scroll by lastContentY — NOT lastContentY + 1. That leaves the
  // final non-blank row in the viewport for the shell's imminent
  // redraw to overwrite in place. For common single-line prompts,
  // that cleanly eliminates what would otherwise be a "duplicate
  // prompt" in scrollback; for multi-line prompts (e.g. starship's
  // line + input-line pair) it reduces the duplicate to a single row
  // rather than burying the full prompt block above the new one.
  //
  // Using the content-row count rather than the full viewport height
  // avoids appending a viewport's worth of blank rows to scrollback
  // each time we split a pane whose viewport has already been
  // redrawn small (e.g. after a previous split).
  const scrolls = lastContentY;
  if (scrolls <= 0) return;
  const moves = Math.max(0, rows - 1 - buf.cursorY);
  inst.term.write("\r" + "\n".repeat(moves + scrolls));
}

function scheduleReclaimHistory(inst: LeafInstance) {
  if (inst.reclaimDisposer) {
    inst.reclaimDisposer();
    inst.reclaimDisposer = null;
  }
  if (inst.reclaimTimer) clearTimeout(inst.reclaimTimer);

  const tryReclaim = (): boolean => {
    const buf = inst.term.buffer.active;
    const lines = reclaimScrollLines({
      rows: inst.term.rows,
      cursorY: buf.cursorY,
      baseY: buf.baseY,
    });
    if (lines < 0) {
      scrollLinesImmediate(inst.term, lines);
      return true;
    }
    return false;
  };

  // The shell's SIGWINCH response arrives asynchronously via pty-output;
  // its timing is a race we can't pin down (hundreds of ms on a cold zsh,
  // sub-20ms on warm runs). Hook onCursorMove and evaluate after every
  // cursor update until the condition fires once, then stop.
  const sub = inst.term.onCursorMove(() => {
    if (tryReclaim()) {
      sub.dispose();
      inst.reclaimDisposer = null;
      if (inst.reclaimTimer) {
        clearTimeout(inst.reclaimTimer);
        inst.reclaimTimer = null;
      }
    }
  });
  inst.reclaimDisposer = () => sub.dispose();
  // Belt-and-suspenders: drop the listener after a second regardless, so
  // we don't keep reacting to unrelated cursor moves far after the split.
  inst.reclaimTimer = setTimeout(() => {
    inst.reclaimTimer = null;
    sub.dispose();
    inst.reclaimDisposer = null;
  }, 1000);
}

function closePtyBestEffort(ptyId: number) {
  void closePty(ptyId).catch((err) => {
    console.error(`Failed to close PTY ${ptyId} during teardown:`, err);
  });
}

function stopAgentTaskTailBestEffort(tabId: number) {
  void stopAgentTaskTail(tabId).catch((err) => {
    console.error(`Failed to stop agent task tail ${tabId}:`, err);
  });
}

function forwardPtyResize(
  inst: LeafInstance,
  nextSize: PtySizeSnapshot = { cols: inst.term.cols, rows: inst.term.rows },
) {
  if (inst.ptyId < 0) return;
  if (!shouldForwardPtyResize(inst.lastPtySize, nextSize)) return;
  inst.lastPtySize = nextSize;
  void resizePty(inst.ptyId, nextSize.cols, nextSize.rows).catch((err) => {
    console.error(`Failed to resize PTY ${inst.ptyId}:`, err);
    const lastSize = inst.lastPtySize;
    if (
      lastSize &&
      lastSize.cols === nextSize.cols &&
      lastSize.rows === nextSize.rows
    ) {
      inst.lastPtySize = null;
    }
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
  const claudetteTerminalEnabled = useAppStore(
    (s) => s.claudetteTerminalEnabled,
  );
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
  const selectedSessionId = useAppStore((s) =>
    s.selectedWorkspaceId
      ? (s.selectedSessionIdByWorkspaceId[s.selectedWorkspaceId] ?? null)
      : null,
  );
  const fontFamilyMono = useAppStore((s) => s.fontFamilyMono);
  const currentThemeId = useAppStore((s) => s.currentThemeId);
  const uiFontSize = useAppStore((s) => s.uiFontSize);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tabId: number;
    leafId?: string;
  } | null>(null);
  // Pointer-event-based tab drag — native HTML5 DnD does not deliver
  // dragover/drop events under the html `zoom` we apply for UI font scaling
  // (WebKit-on-macOS quirk), so we hand-roll the drag with pointer events
  // which work correctly under zoom.
  const tabDragRef = useRef<{
    tabId: number;
    startX: number;
    startY: number;
    pointerId: number;
    active: boolean;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    title: string;
  } | null>(null);
  const tabDragJustEndedRef = useRef(false);
  const [draggingTabId, setDraggingTabId] = useState<number | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{
    tabId: number;
    placement: TabDropPlacement;
  } | null>(null);
  // Cursor position + dragged-tab geometry, captured at drag start so the
  // floating ghost can mimic the source tab's size and offset relative to
  // the click point. Coords are event clientX/Y (visual pixels under html
  // zoom) — the ghost uses viewportToFixed to convert into layout pixels
  // for `position: fixed`.
  const [dragGhost, setDragGhost] = useState<{
    cursorX: number;
    cursorY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    title: string;
  } | null>(null);

  const autoCreatedRef = useRef<string | null>(null);
  // Tracks the last (tabId, leafId, visible) tuple we applied keyboard
  // focus for. The layout effect below re-runs whenever any of its deps
  // change — including unrelated state like a workspace's agent_status —
  // so we gate the focus side-effect on this identity changing. Without
  // this gate, an agent finishing (which updates workspaces) would yank
  // focus out of the chat composer into the terminal.
  const lastFocusKeyRef = useRef<string | null>(null);
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
    () =>
      selectedWorkspaceId
        ? (terminalTabs[selectedWorkspaceId] ?? []).filter(
            (tab) => claudetteTerminalEnabled || tab.kind !== "agent_task",
          )
        : [],
    [claudetteTerminalEnabled, selectedWorkspaceId, terminalTabs],
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

  const handleStopAgentTask = useCallback(async (tab: TerminalTab) => {
    if (!tab.agent_chat_session_id || !tab.agent_task_id) return;
    const label = tab.task_summary?.trim() || tab.title || tab.agent_task_id;
    const ok = window.confirm(
      `Stop background task "${label}"?\n\nThis will terminate the running command.`,
    );
    if (!ok) return;
    try {
      await stopAgentBackgroundTask(tab.agent_chat_session_id, tab.agent_task_id);
    } catch (err) {
      console.error("Failed to stop agent background task:", err);
    }
  }, []);

  // When the panel gets hidden (most often because the user just closed
  // the last tab via the X button or Cmd+W on the last pane) clear the
  // auto-create guard so that the next time the user reveals the panel
  // with no tabs, the load effect below seeds a fresh tab. Without this
  // the guard stays keyed on the workspace forever and toggling the
  // panel back on lands the user on an empty panel.
  useEffect(() => {
    if (!terminalPanelVisible) autoCreatedRef.current = null;
  }, [terminalPanelVisible]);

  // Load tabs on workspace + panel-visibility change.
  useEffect(() => {
    if (!selectedWorkspaceId || !terminalPanelVisible) return;
    const wsId = selectedWorkspaceId;
    listTerminalTabs(wsId).then(async (t) => {
      if (claudetteTerminalEnabled && selectedSessionId) {
        await ensureClaudetteTerminalTab(wsId, selectedSessionId);
        t = await listTerminalTabs(wsId);
      }
      if (t.length > 0) {
        setTerminalTabs(wsId, t);
        const visibleTabs = t.filter(
          (tab) => claudetteTerminalEnabled || tab.kind !== "agent_task",
        );
        const currentActive = useAppStore.getState().activeTerminalTabId[wsId];
        const activeStillValid =
          currentActive != null &&
          visibleTabs.some((tab) => tab.id === currentActive);
        if (!activeStillValid) {
          setActiveTerminalTab(wsId, visibleTabs[0]?.id ?? t[0].id);
        }
        if (!t.some((tab) => tab.kind !== "agent_task")) {
          try {
            const tab = await createTerminalTab(wsId);
            addTerminalTab(wsId, tab);
            setActiveTerminalTab(wsId, claudetteTerminalEnabled ? t[0].id : tab.id);
          } catch (err) {
            console.error("Failed to create terminal tab:", err);
          }
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
    selectedSessionId,
    claudetteTerminalEnabled,
    terminalPanelVisible,
    setTerminalTabs,
    setActiveTerminalTab,
    addTerminalTab,
  ]);

  // When the workspace's tab list becomes empty (e.g. user closed the last
  // tab, triggering the panel to collapse), release the auto-create guard
  // so the next time the panel opens for this workspace we spawn a fresh
  // tab instead of showing an empty panel.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const wsTabs = terminalTabs[selectedWorkspaceId];
    if (wsTabs && wsTabs.length === 0 && autoCreatedRef.current === selectedWorkspaceId) {
      autoCreatedRef.current = null;
    }
  }, [selectedWorkspaceId, terminalTabs]);

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
          const activeTab = (state.terminalTabs[wsId] ?? []).find((t) => t.id === tabId);
          if (activeTab?.kind === "agent_task") return;
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
      const action = terminalKeyAction(ev, useAppStore.getState().keybindings);
      if (!action) {
        if (shouldStopTerminalEventPropagation(ev)) {
          ev.stopImmediatePropagation();
          ev.stopPropagation();
        }
        return true;
      }
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
      const rootZoom = getRootZoom();
      if (rootZoom !== 1) container.style.zoom = String(1 / rootZoom);

      const monoFont =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono")
          .trim() || "monospace";
      const term = new Terminal({
        fontSize: terminalFontSize * rootZoom,
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
      const handleContextMenu = (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        setContextMenu({
          x: ev.clientX,
          y: ev.clientY,
          tabId: spec.tabId,
          leafId: spec.leafId,
        });
      };
      container.addEventListener(
        "contextmenu",
        handleContextMenu,
        terminalContextMenuOptions,
      );

      let currentInst: LeafInstance | null = null;
      const resizeObserver = new ResizeObserver(() => {
        const inst = currentInst;
        if (!inst) return;
        if (inst.fitTimer) clearTimeout(inst.fitTimer);
        inst.fitTimer = setTimeout(() => safeFit(inst), 150);
      });
      const inst: LeafInstance = {
        leafId: spec.leafId,
        tabId: spec.tabId,
        workspaceId: spec.workspaceId,
        worktreePath: spec.worktreePath,
        container,
        term,
        fit,
        ptyId: -1,
        isAgentTask:
          Object.values(terminalTabs)
            .flat()
            .find((tab) => tab.id === spec.tabId)?.kind === "agent_task",
        agentTaskTailPath: null,
        unlisten: null,
        fitTimer: null,
        reclaimTimer: null,
        reclaimDisposer: null,
        handleCopy,
        handleContextMenu,
        keyHandler,
        lastPtySize: null,
        resizeObserver,
      };
      currentInst = inst;
      inst.resizeObserver.observe(container);

      if (inst.isAgentTask) {
        term.options.cursorBlink = false;
        safeFit(inst);
        return inst;
      }

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
            const bytes = Array.from(terminalInputEncoder.encode(data));
            writePty(ptyId, bytes);
          });
          term.onResize(({ cols, rows }) => {
            forwardPtyResize(inst, { cols, rows });
          });

          safeFit(inst);
          forwardPtyResize(inst);
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
    [setPanePtyId, setPaneSpawnError, terminalFontSize, terminalTabs],
  );

  const destroyInstance = useCallback((leafId: string) => {
    const inst = instancesRef.current.get(leafId);
    if (!inst) return;
    if (inst.fitTimer) clearTimeout(inst.fitTimer);
    if (inst.reclaimTimer) clearTimeout(inst.reclaimTimer);
    if (inst.reclaimDisposer) inst.reclaimDisposer();
    inst.resizeObserver.disconnect();
    inst.container.removeEventListener("copy", inst.handleCopy);
    inst.container.removeEventListener(
      "contextmenu",
      inst.handleContextMenu,
      terminalContextMenuOptions,
    );
    inst.term.dispose();
    if (inst.unlisten) inst.unlisten();
    if (inst.isAgentTask) stopAgentTaskTailBestEffort(inst.tabId);
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
    const freshLeafIds = new Set<string>();
    for (const spec of toCreate) {
      instancesRef.current.set(spec.leafId, createInstance(spec));
      freshLeafIds.add(spec.leafId);
    }

    // Reparent each instance's container into its current target div.
    for (const spec of needed) {
      const inst = instancesRef.current.get(spec.leafId);
      if (!inst) continue;
      const selector = `[data-pane-target="${CSS.escape(spec.leafId)}"]`;
      const target = document.querySelector(selector) as HTMLElement | null;
      if (target && inst.container.parentElement !== target) {
        const prevCols = inst.term.cols;
        const prevRows = inst.term.rows;
        target.appendChild(inst.container);
        // The container may have gone from 0×0 to a real size — refit
        // immediately so the user doesn't see an 80×24 stub.
        safeFit(inst);
        forwardPtyResize(inst);
        const resized =
          inst.term.cols !== prevCols || inst.term.rows !== prevRows;
        if (freshLeafIds.has(spec.leafId)) {
          // Brand-new pane: park the cursor at the bottom so the fresh
          // prompt is visible.
          inst.term.scrollToBottom();
        } else if (resized && inst.ptyId >= 0) {
          // The shell is about to receive SIGWINCH and will typically
          // respond with \e[H\e[J (cursor home + erase to end of
          // display), which xterm implements as an in-place erase of
          // the visible rows — the user's recent output is NOT moved
          // to scrollback, it's wiped. To salvage it, synchronously
          // pad the xterm buffer with enough blank lines that the
          // current viewport content is safely above ybase before the
          // shell's redraw arrives (this injection happens on the
          // microtask queue ahead of any pty-output event). Once the
          // shell has redrawn its prompt we also slide the display up
          // so the user can see the reclaimed scrollback above it.
          padViewportIntoScrollback(inst);
          scheduleReclaimHistory(inst);
        }
      }
    }

    // Apply keyboard focus to whichever leaf the store says is active
    // for the currently-selected tab. We do this in the same
    // useLayoutEffect (rather than a separate useEffect with a deferred
    // timer) because rapid-fire state changes at startup or during a
    // split were cancelling the deferred focus calls before they could
    // run. Doing the focus synchronously here — after reparent, in the
    // same render cycle — guarantees exactly one focus attempt per
    // applied layout change.
    //
    // Gate on focus-target identity changing: this effect re-runs on
    // every workspace update too (deps include `workspaces`), and an
    // unconditional focus call would steal focus from the chat
    // composer whenever an agent finishes.
    const nextFocusedLeafId =
      terminalPanelVisible && activeTerminalTabId != null
        ? activeTerminalPaneId[activeTerminalTabId] ?? null
        : null;
    const nextFocusKey =
      terminalPanelVisible && activeTerminalTabId != null && nextFocusedLeafId
        ? `${activeTerminalTabId}:${nextFocusedLeafId}`
        : null;
    if (nextFocusKey !== null && nextFocusKey !== lastFocusKeyRef.current) {
      const inst = instancesRef.current.get(nextFocusedLeafId!);
      if (
        inst &&
        shouldFocusLeaf(
          nextFocusedLeafId!,
          inst.tabId,
          activeTerminalPaneId,
          activeTerminalTabId!,
          terminalPanelVisible,
        )
      ) {
        // The helper textarea is what xterm's own click-focus
        // path uses; calling term.focus() directly can no-op on
        // the very first mount. We deliberately don't scrollToBottom
        // here — if the user was reading scrollback, clicking a pane
        // to focus it (or any other action that triggers a
        // re-focus, like a pane split that promotes a sibling)
        // should leave their scroll position alone.
        const helper = inst.container.querySelector(
          ".xterm-helper-textarea",
        ) as HTMLTextAreaElement | null;
        if (helper) helper.focus({ preventScroll: true });
        else inst.term.focus();
      }
    }
    lastFocusKeyRef.current = nextFocusKey;
  }, [
    terminalTabs,
    workspaces,
    terminalPaneTrees,
    activeTerminalPaneId,
    activeTerminalTabId,
    terminalPanelVisible,
    createInstance,
    destroyInstance,
  ]);

  useEffect(() => {
    const tabsById = new Map<number, TerminalTab>();
    for (const wsTabs of Object.values(terminalTabs)) {
      for (const tab of wsTabs) tabsById.set(tab.id, tab);
    }
    for (const inst of instancesRef.current.values()) {
      if (!inst.isAgentTask) continue;
      const tab = tabsById.get(inst.tabId);
      const outputPath = tab?.output_path ?? null;
      if (!outputPath || inst.agentTaskTailPath === outputPath) continue;
      if (inst.unlisten) {
        inst.unlisten();
        inst.unlisten = null;
      }
      stopAgentTaskTailBestEffort(inst.tabId);
      inst.agentTaskTailPath = outputPath;
      inst.term.clear();
      (async () => {
        const unlistenFn = await listen<AgentTaskOutputPayload>(
          "agent-task-output",
          (event) => {
            if (event.payload.tab_id === inst.tabId) {
              if (event.payload.reset) inst.term.clear();
              if (event.payload.data.length > 0) {
                inst.term.write(new Uint8Array(event.payload.data));
              }
            }
          },
        );
        if (instancesRef.current.get(inst.leafId) !== inst) {
          unlistenFn();
          stopAgentTaskTailBestEffort(inst.tabId);
          return;
        }
        inst.unlisten = unlistenFn;
        await startAgentTaskTail(inst.tabId, outputPath);
      })().catch((err) => {
        console.error("Failed to start agent task tail:", err);
      });
    }
  }, [terminalTabs, tabs]);

  // Font / theme propagation across all live instances. uiFontSize is
  // bundled in here because it drives the page-zoom compensation: when
  // the user changes UI size, every terminal needs its container zoom
  // and effective font-size updated together (see applyZoomCompensation).
  useEffect(() => {
    const rootZoom = getRootZoom();
    for (const inst of instancesRef.current.values()) {
      applyZoomCompensation(inst, rootZoom, terminalFontSize);
      safeFit(inst);
    }
  }, [terminalFontSize, uiFontSize]);

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

  // Refit on panel-visibility / tab-switch transitions. Focus is handled
  // by the dedicated active-leaf effect below, which respects the
  // per-tab active pane rather than indiscriminately focusing the first
  // xterm helper textarea it finds.
  useEffect(() => {
    if (!terminalPanelVisible) return;
    const id = requestAnimationFrame(() => {
      for (const inst of instancesRef.current.values()) {
        safeFit(inst);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [terminalPanelVisible, activeTerminalTabId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  const handleClearContextTerminal = useCallback(() => {
    if (!contextMenu) return;
    if (contextMenu.leafId) {
      instancesRef.current.get(contextMenu.leafId)?.term.clear();
    } else {
      for (const inst of instancesRef.current.values()) {
        if (inst.tabId === contextMenu.tabId) inst.term.clear();
      }
    }
    setContextMenu(null);
  }, [contextMenu]);

  const terminalContextMenuItems = useMemo<AttachmentContextMenuItem[]>(
    () => [
      {
        label: "Clear terminal",
        onSelect: handleClearContextTerminal,
      },
    ],
    [handleClearContextTerminal],
  );

  const handleTabContextMenu = useCallback(
    (ev: ReactMouseEvent<HTMLDivElement>, tab: TerminalTab) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (selectedWorkspaceId) setActiveTerminalTab(selectedWorkspaceId, tab.id);
      setContextMenu({
        x: ev.clientX,
        y: ev.clientY,
        tabId: tab.id,
      });
    },
    [selectedWorkspaceId, setActiveTerminalTab],
  );

  const handleTabPointerDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>, tab: TerminalTab) => {
      if (ev.button !== 0) return;
      const target = ev.target as HTMLElement;
      if (target.closest(`.${styles.tabClose}, .${styles.tabStop}`)) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      tabDragRef.current = {
        tabId: tab.id,
        startX: ev.clientX,
        startY: ev.clientY,
        pointerId: ev.pointerId,
        active: false,
        offsetX: ev.clientX - rect.left,
        offsetY: ev.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        title: tab.title,
      };
      try {
        ev.currentTarget.setPointerCapture(ev.pointerId);
      } catch {
        // setPointerCapture can throw if the pointer was already released
        // synchronously (rare, e.g. during programmatic events) — treat it
        // as the user not committing to a drag.
        tabDragRef.current = null;
      }
    },
    [],
  );

  const handleTabPointerMove = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      const drag = tabDragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      if (!drag.active) {
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        // 4px hysteresis — anything below is treated as a click.
        if (dx * dx + dy * dy < 16) return;
        drag.active = true;
        setDraggingTabId(drag.tabId);
      }
      // Move the floating ghost to follow the cursor, preserving the
      // offset between the cursor and the source tab's top-left so the
      // ghost doesn't snap-jump when drag activates.
      setDragGhost({
        cursorX: ev.clientX,
        cursorY: ev.clientY,
        offsetX: drag.offsetX,
        offsetY: drag.offsetY,
        width: drag.width,
        height: drag.height,
        title: drag.title,
      });
      const overEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const tabEl = overEl?.closest<HTMLElement>("[data-terminal-tab-id]") ?? null;
      const overId = tabEl ? Number(tabEl.dataset.terminalTabId) : null;
      if (overId == null || overId === drag.tabId || !tabEl) {
        setTabDropTarget((prev) => (prev === null ? prev : null));
        return;
      }
      const r = tabEl.getBoundingClientRect();
      const placement = tabDropPlacement(ev.clientX, r.left, r.width);
      setTabDropTarget((prev) =>
        prev && prev.tabId === overId && prev.placement === placement
          ? prev
          : { tabId: overId, placement },
      );
    },
    [],
  );

  const finishTabDrag = useCallback(
    (committedHover: typeof tabDropTarget) => {
      const drag = tabDragRef.current;
      tabDragRef.current = null;
      setDraggingTabId(null);
      setTabDropTarget(null);
      setDragGhost(null);
      if (!drag) return;
      if (!drag.active) {
        // No movement → click — onClick on the tab handles activation.
        return;
      }
      // Suppress the synthetic click that follows pointerup on the captured
      // tab, otherwise a drag would also re-activate the source tab.
      tabDragJustEndedRef.current = true;
      // Clear the suppressor on the next microtask, after the click handler
      // has had a chance to run.
      queueMicrotask(() => {
        tabDragJustEndedRef.current = false;
      });
      if (
        !committedHover ||
        committedHover.tabId === drag.tabId ||
        !selectedWorkspaceId
      ) {
        return;
      }
      const currentTabs = terminalTabs[selectedWorkspaceId] ?? [];
      const reordered = reorderTerminalTabs(
        currentTabs,
        drag.tabId,
        committedHover.tabId,
        committedHover.placement,
      );
      if (!reordered) return;
      setTerminalTabs(selectedWorkspaceId, reordered);
      setActiveTerminalTab(selectedWorkspaceId, drag.tabId);
      void updateTerminalTabOrder(
        selectedWorkspaceId,
        reordered.map((tab) => tab.id),
      ).catch((err) =>
        console.error("Failed to persist terminal tab order:", err),
      );
    },
    [
      selectedWorkspaceId,
      setActiveTerminalTab,
      setTerminalTabs,
      terminalTabs,
    ],
  );

  const handleTabPointerUp = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      const drag = tabDragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      try {
        ev.currentTarget.releasePointerCapture(ev.pointerId);
      } catch {
        // Already released.
      }
      finishTabDrag(tabDropTarget);
    },
    [finishTabDrag, tabDropTarget],
  );

  const handleTabPointerCancel = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      const drag = tabDragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      try {
        ev.currentTarget.releasePointerCapture(ev.pointerId);
      } catch {
        // Already released.
      }
      finishTabDrag(null);
    },
    [finishTabDrag],
  );

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
      <div
        className={styles.tabBar}
        data-tab-dragging={draggingTabId !== null || undefined}
      >
        {tabs.map((tab) => {
          const isDragging = draggingTabId === tab.id;
          const dropBefore =
            tabDropTarget?.tabId === tab.id && tabDropTarget.placement === "before";
          const dropAfter =
            tabDropTarget?.tabId === tab.id && tabDropTarget.placement === "after";
          return (
          <div
            key={tab.id}
            data-terminal-tab-id={tab.id}
            data-drop-before={dropBefore || undefined}
            data-drop-after={dropAfter || undefined}
            className={`${styles.tab} ${activeTerminalTabId === tab.id ? styles.tabActive : ""} ${isDragging ? styles.tabDragging : ""}`}
            onClick={() => {
              if (tabDragJustEndedRef.current) return;
              if (selectedWorkspaceId)
                setActiveTerminalTab(selectedWorkspaceId, tab.id);
            }}
            onContextMenu={(e) => handleTabContextMenu(e, tab)}
            onPointerDown={(e) => handleTabPointerDown(e, tab)}
            onPointerMove={handleTabPointerMove}
            onPointerUp={handleTabPointerUp}
            onPointerCancel={handleTabPointerCancel}
          >
            <span className={styles.tabTitle}>{tab.title}</span>
            {tab.kind === "agent_task" && tab.task_status && (
              <span className={styles.tabBadge}>{tab.task_status}</span>
            )}
            {tab.kind === "agent_task" &&
              tab.agent_task_id &&
              ["starting", "running"].includes((tab.task_status ?? "").toLowerCase()) && (
                <button
                  className={styles.tabStop}
                  title="Stop background task"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleStopAgentTask(tab);
                  }}
                >
                  ■
                </button>
              )}
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
          );
        })}
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
      {contextMenu && (
        <AttachmentContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={terminalContextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
      {dragGhost && draggingTabId !== null && <TabDragGhost ghost={dragGhost} />}
    </div>
  );
});

function TabDragGhost({
  ghost,
}: {
  ghost: {
    cursorX: number;
    cursorY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    title: string;
  };
}) {
  // Translate the cursor position from event coords (visual pixels under
  // html zoom) into layout pixels for `position: fixed` placement, then
  // anchor the ghost at the same offset within the tab where the user
  // grabbed it. Without this, dragging mid-tab would teleport the ghost's
  // top-left to the cursor and jitter on first move.
  const top = viewportToFixed(0, ghost.cursorY - ghost.offsetY).y;
  const left = viewportToFixed(ghost.cursorX - ghost.offsetX, 0).x;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className={styles.tabGhost}
      style={{ left, top, width: ghost.width, height: ghost.height }}
      aria-hidden
    >
      <span className={styles.tabGhostTitle}>{ghost.title}</span>
    </div>,
    document.body,
  );
}
