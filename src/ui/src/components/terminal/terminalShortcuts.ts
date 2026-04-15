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

  return null;
}
