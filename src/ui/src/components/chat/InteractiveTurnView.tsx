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
  // Tracks how many bytes from `bytes` have already been written into
  // the live xterm instance. We use this to (a) replay the accumulated
  // buffer when the terminal is recreated on a rows/cols change, and
  // (b) write only the new tail when `bytes` grows.
  const lastWrittenLenRef = useRef(0);
  // The bytes-effect needs the current value of `bytes` but we don't
  // want it to re-run on every prop change just to capture the latest —
  // a ref keeps the mount effect in sync with whatever the latest
  // `bytes` prop is at the moment it runs.
  const bytesRef = useRef(bytes);
  bytesRef.current = bytes;

  // Mount/unmount the terminal. We intentionally rebuild the instance if
  // `rows`/`cols` change because xterm.js's `resize()` triggers extra
  // renderer work that's pointless for a static per-turn view — the
  // chat host wires those dimensions once when the turn is created.
  // After remount we replay the accumulated `bytes` so a resize doesn't
  // wipe the turn's contents.
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

    // Replay the current accumulated buffer into the freshly-created
    // terminal. Without this, a rows/cols change would leave the new
    // terminal empty until the parent next mutated `bytes`.
    const current = bytesRef.current;
    if (current.length > 0) {
      term.write(current);
    }
    lastWrittenLenRef.current = current.length;

    termRef.current = term;
    return () => {
      term.dispose();
      termRef.current = null;
      lastWrittenLenRef.current = 0;
    };
  }, [rows, cols]);

  // Write incoming bytes whenever they change. The mount effect already
  // replays the accumulated buffer when the terminal is (re)created, so
  // here we only ever emit the new tail — except when the parent swaps
  // in a shorter buffer (a brand-new turn payload), in which case we
  // clear and rewrite from scratch.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const lastLen = lastWrittenLenRef.current;
    if (bytes.length > lastLen) {
      // Common case: parent appended more bytes to the cumulative
      // buffer. Write only the new tail to avoid re-rendering the whole
      // turn on every chunk.
      term.write(lastLen === 0 ? bytes : bytes.subarray(lastLen));
      lastWrittenLenRef.current = bytes.length;
    } else if (bytes.length < lastLen) {
      // Parent replaced the buffer with something shorter — treat as a
      // fresh payload and rewrite from scratch.
      term.clear();
      term.reset();
      term.write(bytes);
      lastWrittenLenRef.current = bytes.length;
    }
    // Equal-length case: nothing new to write. (If a parent ever passes
    // a same-length-but-different buffer, that's outside this view's
    // contract — bytes are expected to be append-only or replaced.)
  }, [bytes]);

  return <div ref={containerRef} className={styles.interactiveTurnView} />;
}
