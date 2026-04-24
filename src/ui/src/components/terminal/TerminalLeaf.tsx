import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../stores/useAppStore";
import { getTerminalTheme } from "../../utils/theme";
import {
  openUrl,
  spawnPty,
  writePty,
  resizePty,
  closePty,
} from "../../services/tauri";
import { trimSelectionTrailingWhitespace } from "./terminalSelection";
import "@xterm/xterm/css/xterm.css";
import styles from "./TerminalPanel.module.css";

interface PtyOutputPayload {
  pty_id: number;
  data: number[];
}

export interface TerminalLeafProps {
  tabId: number;
  leafId: string;
  workspaceId: string;
  worktreePath: string;
  isActivePane: boolean;
  // xterm's attachCustomKeyEventHandler callback. TerminalPanel.tsx builds
  // this once (it captures split/close/navigate handlers) and shares it
  // across every leaf so behaviour stays consistent and the leaf component
  // itself knows nothing about the tree.
  keyHandler: (ev: KeyboardEvent) => boolean;
  // Handler invoked on pointerdown inside the leaf so the pane-tree knows
  // which leaf is focused without us having to reach into the store from here.
  onActivate: () => void;
  // Render-once hint: mounting/unmounting a TerminalLeaf creates/destroys
  // the PTY and xterm. Containers for inactive tabs are toggled via
  // `display:none` in the parent.
}

// Mirrors TerminalPanel's original safeFit: the fit addon throws when called
// against a container with no layout size (e.g. display:none), which happens
// during workspace switches and panel collapses.
function safeFit(fit: FitAddon, container: HTMLElement) {
  if (container.clientHeight > 0 && container.clientWidth > 0) fit.fit();
}

function closePtyBestEffort(ptyId: number) {
  void closePty(ptyId).catch((err) => {
    console.error(`Failed to close PTY ${ptyId} during teardown:`, err);
  });
}

/**
 * A single leaf in the pane tree: one xterm.js instance bound to one PTY.
 *
 * Owns its own spawn → listen → write → resize → close lifecycle. Unmount
 * (triggered when the leaf disappears from the tree via closePane) tears
 * down the PTY and disposes the xterm instance.
 *
 * We render a `<div>` that xterm attaches to (via term.open), and a
 * separate absolute-positioned error overlay when spawn fails.
 */
export const TerminalLeaf = memo(function TerminalLeaf({
  tabId,
  leafId,
  workspaceId,
  worktreePath,
  isActivePane,
  keyHandler,
  onActivate,
}: TerminalLeafProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number>(-1);
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const fontFamilyMono = useAppStore((s) => s.fontFamilyMono);
  const currentThemeId = useAppStore((s) => s.currentThemeId);
  const setPanePtyId = useAppStore((s) => s.setPanePtyId);
  const setPaneSpawnError = useAppStore((s) => s.setPaneSpawnError);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [spawnKey, setSpawnKey] = useState(0);

  // Keep a stable reference to the keyHandler so our (otherwise stable)
  // xterm setup effect doesn't tear down on every render of the parent.
  const keyHandlerRef = useRef(keyHandler);
  useEffect(() => {
    keyHandlerRef.current = keyHandler;
  }, [keyHandler]);

  // Spawn / teardown effect. Runs once per (leafId, spawnKey) — the Retry
  // button increments spawnKey to force a clean re-initialization.
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

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

    term.attachCustomKeyEventHandler((ev) => keyHandlerRef.current(ev));

    term.open(host);
    safeFit(fit, host);

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
    host.addEventListener("copy", handleCopy);

    terminalRef.current = term;
    fitRef.current = fit;

    const resizeObserver = new ResizeObserver(() => {
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
      fitTimerRef.current = setTimeout(() => {
        if (host.clientHeight > 0 && host.clientWidth > 0) fit.fit();
      }, 150);
    });
    resizeObserver.observe(host);

    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    (async () => {
      try {
        const state = useAppStore.getState();
        const currentWs = state.workspaces.find((w) => w.id === workspaceId);
        const currentRepo = currentWs
          ? state.repositories.find((r) => r.id === currentWs.repository_id)
          : undefined;
        const defaults = state.defaultBranches;
        const ptyId = await spawnPty(
          worktreePath,
          currentWs?.name ?? "",
          workspaceId,
          currentRepo?.path ?? "",
          currentWs ? (defaults[currentWs.repository_id] ?? "main") : "main",
          currentWs?.branch_name ?? "",
        );
        if (cancelled) {
          closePtyBestEffort(ptyId);
          return;
        }
        ptyIdRef.current = ptyId;
        setPanePtyId(tabId, leafId, ptyId);

        unlistenFn = await listen<PtyOutputPayload>("pty-output", (event) => {
          if (event.payload.pty_id === ptyId) {
            term.write(new Uint8Array(event.payload.data));
          }
        });
        if (cancelled) {
          unlistenFn();
          unlistenFn = null;
          closePtyBestEffort(ptyId);
          return;
        }

        term.onData((data) => {
          const bytes = Array.from(new TextEncoder().encode(data));
          writePty(ptyId, bytes);
        });
        term.onResize(({ cols, rows }) => {
          resizePty(ptyId, cols, rows);
        });

        safeFit(fit, host);
        resizePty(ptyId, term.cols, term.rows);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to initialize terminal leaf:", err);
        const msg = err instanceof Error ? err.message : String(err);
        setSpawnError(msg);
        setPaneSpawnError(tabId, leafId, msg);
      }
    })();

    return () => {
      cancelled = true;
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
      resizeObserver.disconnect();
      host.removeEventListener("copy", handleCopy);
      term.dispose();
      if (unlistenFn) unlistenFn();
      if (ptyIdRef.current >= 0) closePtyBestEffort(ptyIdRef.current);
      ptyIdRef.current = -1;
      terminalRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId, spawnKey, tabId, workspaceId, worktreePath]);

  // Refit whenever pane-sizing forces the container to change dimensions.
  // The ResizeObserver handles passive size changes; this effect re-fits
  // immediately when the "active" flag flips (the handle may have just been
  // revealed) so the user sees crisp sizing without waiting for the 150ms
  // debounce timer.
  useEffect(() => {
    const host = containerRef.current;
    const fit = fitRef.current;
    const term = terminalRef.current;
    if (!host || !fit || !term) return;
    if (!isActivePane) return;
    safeFit(fit, host);
    term.focus();
  }, [isActivePane]);

  // Font and theme updates (parent-driven, don't require re-spawn).
  useEffect(() => {
    const term = terminalRef.current;
    const fit = fitRef.current;
    const host = containerRef.current;
    if (!term || !fit || !host) return;
    term.options.fontSize = terminalFontSize;
    safeFit(fit, host);
  }, [terminalFontSize]);

  useEffect(() => {
    const term = terminalRef.current;
    const fit = fitRef.current;
    const host = containerRef.current;
    if (!term || !fit || !host) return;
    const monoFont =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim() || "monospace";
    term.options.theme = getTerminalTheme();
    term.options.fontFamily = monoFont;
    safeFit(fit, host);
  }, [currentThemeId, fontFamilyMono]);

  const handleRetry = useCallback(() => {
    setSpawnError(null);
    setPaneSpawnError(tabId, leafId, null);
    // Force the spawn effect to rerun by changing the `spawnKey`.
    setSpawnKey((k) => k + 1);
  }, [leafId, setPaneSpawnError, tabId]);

  const handleActivate = useCallback(() => {
    onActivate();
  }, [onActivate]);

  return (
    <div
      className={`${styles.paneLeaf} ${isActivePane ? styles.paneLeafActive : ""}`}
      onPointerDown={handleActivate}
      data-pane-leaf-id={leafId}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {spawnError && (
        <div className={styles.paneLeafError} role="alert">
          <div className={styles.spawnErrorTitle}>Failed to start shell</div>
          <div className={styles.spawnErrorMessage}>{spawnError}</div>
          <button className={styles.spawnErrorRetry} onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
});
