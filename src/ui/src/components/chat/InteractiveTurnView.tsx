// Per-turn embedded xterm.js view for interactive (tmux/sidecar) Claude
// sessions.
//
// G6 renders one of these per assembled `Turn` (see
// `hooks/useInteractiveTurnAssembler.ts`) inside the chat panel. Each
// instance owns a small xterm.js terminal that only ever receives the
// bytes belonging to that turn — there is no PTY attached, no input
// forwarding, and no resize wiring beyond the initial FitAddon pass.
// The xterm.js viewport is intentionally fixed-size so adjacent turns
// stack predictably; the host (ChatPanel) decides how to lay them out.
//
// Theme colors come from `getTerminalTheme()` which reads the CSS custom
// properties on `<html>` — keeps these turn views in lockstep with the
// rest of the app (and out of `bun run lint:css`'s way).

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getTerminalTheme } from "../../utils/theme";
import "@xterm/xterm/css/xterm.css";
import styles from "./InteractiveTurnView.module.css";

interface InteractiveTurnViewProps {
  bytes: Uint8Array;
  rows?: number;
  cols?: number;
}

export function InteractiveTurnView({
  bytes,
  rows = 24,
  cols = 80,
}: InteractiveTurnViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  // Mount/unmount the terminal. We intentionally rebuild the instance if
  // `rows`/`cols` change because xterm.js's `resize()` triggers extra
  // renderer work that's pointless for a static per-turn view — the
  // chat host wires those dimensions once when the turn is created.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const monoFont =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim() || "monospace";

    const term = new Terminal({
      rows,
      cols,
      fontFamily: monoFont,
      theme: getTerminalTheme(),
      // Per-turn views are read-only — disable the cursor so a frozen
      // turn doesn't pretend it's accepting keystrokes.
      cursorBlink: false,
      cursorStyle: "block",
      disableStdin: true,
      // xterm.js's unicode subsystem is reached behind the proposed-API
      // flag; matching TerminalPanel here keeps width tables consistent
      // even though we don't switch to Unicode 11 in this read-only view.
      allowProposedApi: true,
      scrollback: 0,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // FitAddon needs the host to have a real width before it can compute
    // cell dimensions. In jsdom/happy-dom layout returns zeros, in which
    // case `fit()` is a no-op — the constructor's explicit rows/cols
    // already produced a usable terminal.
    try {
      fit.fit();
    } catch {
      // Swallow: a missing renderer dimension in tests/headless DOM
      // shouldn't tear the component down.
    }

    termRef.current = term;
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, [rows, cols]);

  // Write incoming bytes whenever they change. We always start from a
  // fresh terminal on mount, so a parent that swaps in a brand-new
  // `bytes` reference will see the full payload replayed. For "append"
  // semantics on a live turn, the parent should pass the cumulative
  // byte buffer — that's the contract G6 uses.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.write(bytes);
  }, [bytes]);

  return <div ref={containerRef} className={styles.interactiveTurnView} />;
}
