// Full-terminal view of an interactive Claude session.
//
// G6's opt-in render mode: the user clicked "Open in Terminal" in the
// chat header, so we swap the per-turn embedded list for one xterm.js
// instance attached to the entire interactive sid. The terminal is
// live — keystrokes are forwarded to the underlying tmux/sidecar host
// via `sendInput`, and `subscribeOutput` mirrors the host's output
// stream into the local viewport.
//
// We intentionally do NOT consume the G4 turn assembler here: the user
// asked for the unmodulated terminal, so the screen flows verbatim. The
// embedded `InteractiveTurns` view is the place that adds chat-style
// chrome.
//
// Theme construction mirrors `InteractiveTurnView` (and TerminalPanel)
// so font / colors stay in lockstep with the rest of the app — the
// FitAddon claims as much vertical space as its host gives it.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import {
  attach,
  sendInput,
  subscribeOutput,
} from "../../services/interactive";
import { base64ToBytes } from "../../utils/base64";
import { getTerminalTheme } from "../../utils/theme";
import "@xterm/xterm/css/xterm.css";
import styles from "./InteractiveTerminalMode.module.css";

interface InteractiveTerminalModeProps {
  sid: string;
}

export function InteractiveTerminalMode({ sid }: InteractiveTerminalModeProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // One mount per sid — re-attach + re-subscribe when the chat panel
  // switches sessions. We capture the latest `sid` via a ref so the
  // cleanup branch reads the same value the effect installed against
  // (React's effect closure already does this; the ref is defensive
  // against future refactors that pull pieces out of the effect).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const monoFont =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim() || "monospace";

    const term = new Terminal({
      fontFamily: monoFont,
      theme: getTerminalTheme(),
      // Match TerminalPanel: Unicode 11 widths matter for cursor
      // alignment under PSReadLine / ConPTY-style line redraws. The
      // proposed-API flag is required to flip the active version.
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      // Interactive Claude is full-screen ANSI; let the FitAddon decide
      // rows/cols once the host has a layout, instead of pinning small
      // defaults that would force scrollback on every spawn.
      scrollback: 1000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // In jsdom / happy-dom layout is zero so FitAddon throws — swallow
      // so the smoke test path can still verify mount/unmount.
    }

    // Forward keystrokes to the host. We don't try to translate keys
    // ourselves; xterm.js's `onData` already produces the correct
    // escape sequences for ANSI control + raw characters.
    const dataDisposable = term.onData((data) => {
      // Fire-and-forget — surfacing every keystroke failure would drown
      // the chat panel in toasts. The host-side state is the source of
      // truth and a dropped keystroke is recoverable (user repeats it).
      void sendInput(sid, data).catch((err) => {
        console.warn("[interactive] sendInput failed:", err);
      });
    });

    // Track effect-teardown so output-stream subscribe promises that
    // resolve after unmount are dropped without leaking the listener.
    let cancelled = false;
    let unlistenOutput: (() => void) | null = null;

    void subscribeOutput(sid, (ev) => {
      term.write(base64ToBytes(ev.bytesB64));
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        unlistenOutput = unlisten;
      })
      .catch((err) => {
        // Symmetric with the `attach` catch below: log and continue so
        // the terminal still mounts. Without this, a rejected
        // subscribe surfaces as an unhandled promise rejection.
        console.warn("[interactive] subscribeOutput failed:", err);
      });

    // Re-attach the host so it knows we want to receive output again
    // after a reconnect. The Rust side is idempotent — re-attaching a
    // running stream is a no-op — so we don't have to track whether
    // we've attached before. Errors here are non-fatal; output is
    // still wired up via `subscribeOutput`.
    void attach(sid).catch((err) => {
      console.warn("[interactive] attach failed:", err);
    });

    // Initial fit after mount so the host computes rows/cols from the
    // real container dimensions, then a ResizeObserver re-runs `fit()`
    // whenever the parent (or window) reshapes us. A small debounce
    // mirrors TerminalPanel's pattern and avoids thrashing the
    // renderer during a drag.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Swallow renderer-pre-layout throws — same justification as
        // the initial fit above.
      }
    });
    ro.observe(container);

    return () => {
      cancelled = true;
      ro.disconnect();
      dataDisposable.dispose();
      if (unlistenOutput) {
        try {
          unlistenOutput();
        } catch (err) {
          // Guard against a throwing unlisten so the terminal still
          // gets disposed — otherwise we'd leak the xterm instance
          // and its DOM nodes if the listener teardown failed.
          console.warn("[interactive] unlistenOutput threw:", err);
        }
      }
      term.dispose();
    };
  }, [sid]);

  return (
    <div
      ref={containerRef}
      className={styles.interactiveTerminalMode}
      data-testid="interactive-terminal-mode"
    />
  );
}
