/**
 * Pure helpers for terminal-scoped keyboard shortcuts.
 *
 * Kept free of xterm.js / React imports so they can be unit-tested in
 * isolation. The xterm `attachCustomKeyEventHandler` call in TerminalPanel.tsx
 * delegates to `terminalKeyAction` to decide whether a key event should be
 * intercepted, and which of these cycle helpers to call.
 */

/**
 * Returns the id of the tab at `currentIndex + offset` with wrap-around.
 *
 * - Returns `null` for empty lists.
 * - Returns the sole tab's id (no-op) for single-tab lists.
 * - If `activeId` is not in `tabIds`, treats the first tab as the cursor so
 *   Cmd+Shift+] still does something sensible.
 */
export function cycleTabId(
  tabIds: readonly number[],
  activeId: number | null,
  offset: 1 | -1,
): number | null {
  if (tabIds.length === 0) return null;
  if (tabIds.length === 1) return tabIds[0];
  const idx = activeId === null ? 0 : tabIds.indexOf(activeId);
  const from = idx < 0 ? 0 : idx;
  const next = (from + offset + tabIds.length) % tabIds.length;
  return tabIds[next];
}

/**
 * Discriminated result of evaluating a keyboard event for a terminal-scoped
 * shortcut. `null` means the event is not a shortcut we care about — xterm
 * should forward the key to the PTY as normal.
 *
 * `toggle-panel` and `focus-chat` are special: they exist only so xterm
 * doesn't send the key to the PTY (e.g. so Cmd+` doesn't end up as a
 * literal backtick in the shell). The actual toggle/focus behavior is
 * shared with the window-level handler in `useKeyboardShortcuts.ts`.
 */
export type TerminalKeyAction =
  | { kind: "cycle"; direction: "prev" | "next" }
  | { kind: "new-tab" }
  | { kind: "toggle-panel" }
  | { kind: "focus-chat" }
  | { kind: "zoom"; direction: "in" | "out" }
  | { kind: "split-pane"; direction: "horizontal" | "vertical" }
  | { kind: "close-pane" }
  | { kind: "focus-pane"; direction: "left" | "right" | "up" | "down" }
  | null;

/**
 * Decide whether a keyboard event should trigger a terminal-scoped action.
 *
 * The xterm handler uses the result to call `preventDefault()`,
 * `stopImmediatePropagation()`, and `return false` so that:
 * - xterm does not send bytes to the PTY (e.g. "t" for Cmd+T)
 * - the window-level shortcut listener in `useKeyboardShortcuts.ts` does not
 *   also fire (e.g. Cmd+Shift+[/] would otherwise cycle workspaces)
 *
 * We intentionally shadow the global Cmd+Shift+[/] workspace-cycle when the
 * terminal has focus — this is the behavior the issue specifies.
 */
export function terminalKeyAction(ev: KeyboardEvent): TerminalKeyAction {
  if (ev.type !== "keydown") return null;
  const mod = ev.metaKey || ev.ctrlKey;
  if (!mod) return null;

  // Cmd+Shift+[ / Cmd+Shift+] — prev/next terminal tab.
  // The bracketed-key surface is messy across layouts and Shift state
  // (`[`/`]` vs. `{`/`}` vs. `Bracket*` codes), so accept all spellings.
  if (ev.shiftKey) {
    const prev = ev.key === "[" || ev.key === "{" || ev.code === "BracketLeft";
    const next = ev.key === "]" || ev.key === "}" || ev.code === "BracketRight";
    if (prev) return { kind: "cycle", direction: "prev" };
    if (next) return { kind: "cycle", direction: "next" };
  }

  // New-tab: Cmd+T on macOS, Ctrl+Shift+T on Linux/Windows (browser
  // convention). We specifically do NOT intercept bare Ctrl+T because that
  // is readline's `transpose-chars` binding — hijacking it would break a
  // standard shell shortcut inside the terminal. Meta+T (macOS) is safe
  // because Cmd-keys never reach the shell.
  const isT = ev.key === "t" || ev.key === "T";
  if (isT && ev.metaKey && !ev.ctrlKey && !ev.shiftKey) {
    return { kind: "new-tab" };
  }
  if (isT && ev.ctrlKey && ev.shiftKey && !ev.metaKey) {
    return { kind: "new-tab" };
  }

  // Cmd+` — toggle terminal panel (and move focus). Intercepted so xterm
  // doesn't send a literal backtick to the shell.
  if (!ev.shiftKey && ev.key === "`") {
    return { kind: "toggle-panel" };
  }

  // Cmd+0 — focus the chat prompt without touching panel visibility.
  if (!ev.shiftKey && ev.key === "0") {
    return { kind: "focus-chat" };
  }

  // Cmd+= / Cmd++ — zoom in; Cmd+- — zoom out.
  // Use ev.code to handle both Cmd+= and Cmd+Shift+= (which sends key="+").
  // Suppress the key from reaching the PTY but let the global handler
  // in useKeyboardShortcuts.ts process the actual zoom.
  if (ev.code === "Equal") {
    return { kind: "zoom", direction: "in" };
  }
  if (ev.code === "Minus") {
    return { kind: "zoom", direction: "out" };
  }

  // Split pane shortcuts, mirroring iTerm2:
  //   Cmd+D         — split side-by-side (horizontal layout; vertical divider)
  //   Cmd+Shift+D   — split stacked (vertical layout; horizontal divider)
  // We use `ev.code` (KeyD) so Dvorak and other layouts still work: the
  // physical D key keeps the binding regardless of what character it emits.
  //
  // We deliberately do NOT intercept bare Ctrl+D because that is the shell's
  // EOF marker — hijacking it would prevent users from logging out of a
  // shell or closing stdin in a running process. Linux/Windows users can
  // split with Ctrl+Shift+D (keeping Shift=stacked would make that combo
  // overloaded, so on those platforms Ctrl+Alt+D selects stacked instead).
  const isD = ev.code === "KeyD" || ev.key === "d" || ev.key === "D";
  if (isD && ev.metaKey && !ev.ctrlKey) {
    return {
      kind: "split-pane",
      direction: ev.shiftKey ? "vertical" : "horizontal",
    };
  }
  if (isD && ev.ctrlKey && ev.shiftKey && !ev.metaKey) {
    // Ctrl+Shift+D — split side-by-side on Linux/Windows.
    // Ctrl+Shift+Alt+D — split stacked on Linux/Windows.
    return {
      kind: "split-pane",
      direction: ev.altKey ? "vertical" : "horizontal",
    };
  }

  // Cmd+W — close the focused pane (macOS only). The TerminalPanel handler
  // falls back to closing the enclosing tab when only one pane remains.
  // We deliberately do NOT intercept bare Ctrl+W on Linux/Windows because
  // it is the standard readline `unix-word-rubout` (delete previous word),
  // and hijacking it would break a widely-used shell shortcut. Linux users
  // can close panes via Ctrl+Shift+W instead.
  const isW = ev.key === "w" || ev.key === "W";
  if (isW && !ev.shiftKey && ev.metaKey && !ev.ctrlKey) {
    return { kind: "close-pane" };
  }
  if (isW && ev.ctrlKey && ev.shiftKey && !ev.metaKey) {
    return { kind: "close-pane" };
  }

  // Cmd+Option+Arrow — move focus between panes. Option/Alt lives on the
  // same physical key as macOS Option and Linux Alt, so both platforms can
  // use the same binding. We require the Alt modifier to avoid clashing
  // with readline word-motion (Meta-b/f) and macOS text-navigation
  // (Cmd+Arrow → beginning/end of line), neither of which uses Alt.
  if (ev.altKey) {
    if (ev.key === "ArrowLeft") return { kind: "focus-pane", direction: "left" };
    if (ev.key === "ArrowRight") return { kind: "focus-pane", direction: "right" };
    if (ev.key === "ArrowUp") return { kind: "focus-pane", direction: "up" };
    if (ev.key === "ArrowDown") return { kind: "focus-pane", direction: "down" };
  }

  return null;
}
