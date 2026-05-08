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
  | { kind: "copy" }
  | { kind: "paste" }
  | null;

/**
 * Returns true when a key should still reach the PTY, but must not bubble to
 * window-level shortcuts.
 *
 * Today this covers bare Ctrl+D on Linux/Windows: the shell should receive
 * EOF, but the global diff-sidebar shortcut must not also fire.
 */
export function shouldStopTerminalEventPropagation(ev: KeyboardEvent): boolean {
  const isD = ev.code === "KeyD" || ev.key === "d" || ev.key === "D";
  return (
    ev.type === "keydown" &&
    isD &&
    ev.ctrlKey &&
    !ev.metaKey &&
    !ev.shiftKey &&
    !ev.altKey
  );
}

/**
 * Decide whether a keyboard event should trigger a terminal-scoped action.
 *
 * The xterm handler uses the result to call `preventDefault()`,
 * `stopImmediatePropagation()`, and `return false` so that:
 * - xterm does not send bytes to the PTY (e.g. "t" for Cmd+T)
 * - the window-level shortcut listener in `useKeyboardShortcuts.ts` does not
 *   also fire (e.g. Cmd+Shift+[/] would otherwise cycle the unified
 *   workspace tab strip via `global.cycle-tab-prev/next`)
 *
 * We intentionally shadow the global Cmd+Shift+[/] tab-cycle when the
 * terminal has focus so the same keys cycle terminal tabs instead — scope
 * isolation routes the press to whichever surface owns the focus.
 */
export function terminalKeyAction(
  ev: KeyboardEvent,
  keybindings: KeybindingMap = {},
): TerminalKeyAction {
  if (ev.type !== "keydown") return null;
  const resolved = resolveHotkeyAction(ev, "terminal", keybindings);
  const action = resolved ?? (Object.keys(keybindings).length === 0 ? legacyTerminalKeyAction(ev) : null);
  switch (action) {
    case "terminal.cycle-tab-prev":
      return { kind: "cycle", direction: "prev" };
    case "terminal.cycle-tab-next":
      return { kind: "cycle", direction: "next" };
    case "terminal.new-tab":
      return { kind: "new-tab" };
    case "terminal.toggle-panel":
      return { kind: "toggle-panel" };
    case "terminal.focus-chat":
      return { kind: "focus-chat" };
    case "terminal.zoom-in":
      return { kind: "zoom", direction: "in" };
    case "terminal.zoom-out":
      return { kind: "zoom", direction: "out" };
    case "terminal.split-pane-horizontal":
      return { kind: "split-pane", direction: "horizontal" };
    case "terminal.split-pane-vertical":
      return { kind: "split-pane", direction: "vertical" };
    case "terminal.close-pane":
      return { kind: "close-pane" };
    case "terminal.focus-pane-left":
      return { kind: "focus-pane", direction: "left" };
    case "terminal.focus-pane-right":
      return { kind: "focus-pane", direction: "right" };
    case "terminal.focus-pane-up":
      return { kind: "focus-pane", direction: "up" };
    case "terminal.focus-pane-down":
      return { kind: "focus-pane", direction: "down" };
    case "terminal.copy-selection":
      return { kind: "copy" };
    case "terminal.paste":
      return { kind: "paste" };
    default:
      return null;
  }
}

function legacyTerminalKeyAction(ev: KeyboardEvent): string | null {
  const mod = ev.metaKey || ev.ctrlKey;
  if (!mod) return null;
  if (ev.shiftKey) {
    const prev = ev.key === "[" || ev.key === "{" || ev.code === "BracketLeft";
    const next = ev.key === "]" || ev.key === "}" || ev.code === "BracketRight";
    if (prev) return "terminal.cycle-tab-prev";
    if (next) return "terminal.cycle-tab-next";
  }
  const isT = ev.key === "t" || ev.key === "T";
  if (isT && ev.metaKey && !ev.ctrlKey && !ev.shiftKey) return "terminal.new-tab";
  if (isT && ev.ctrlKey && ev.shiftKey && !ev.metaKey) return "terminal.new-tab";
  if (!ev.shiftKey && ev.key === "`") return "terminal.toggle-panel";
  if (!ev.shiftKey && ev.key === "0") return "terminal.focus-chat";
  if (ev.code === "Equal") return "terminal.zoom-in";
  if (ev.code === "Minus") return "terminal.zoom-out";
  const isD = ev.code === "KeyD" || ev.key === "d" || ev.key === "D";
  if (isD && ev.metaKey && !ev.ctrlKey) {
    return ev.shiftKey ? "terminal.split-pane-vertical" : "terminal.split-pane-horizontal";
  }
  if (isD && ev.ctrlKey && ev.shiftKey && !ev.metaKey) {
    return ev.altKey ? "terminal.split-pane-vertical" : "terminal.split-pane-horizontal";
  }
  const isW = ev.key === "w" || ev.key === "W";
  if (isW && !ev.shiftKey && ev.metaKey && !ev.ctrlKey) return "terminal.close-pane";
  if (isW && ev.ctrlKey && ev.shiftKey && !ev.metaKey) return "terminal.close-pane";
  if (ev.altKey) {
    if (ev.key === "ArrowLeft") return "terminal.focus-pane-left";
    if (ev.key === "ArrowRight") return "terminal.focus-pane-right";
    if (ev.key === "ArrowUp") return "terminal.focus-pane-up";
    if (ev.key === "ArrowDown") return "terminal.focus-pane-down";
  }
  const isC = ev.code === "KeyC";
  const isV = ev.code === "KeyV";
  // macOS: Cmd+C/V (without Ctrl or Shift — Ctrl+C must reach the PTY as SIGINT)
  if (isC && ev.metaKey && !ev.ctrlKey && !ev.shiftKey) return "terminal.copy-selection";
  if (isV && ev.metaKey && !ev.ctrlKey && !ev.shiftKey) return "terminal.paste";
  // Linux/Windows: Ctrl+Shift+C/V (bare Ctrl+C stays as SIGINT)
  if (isC && ev.ctrlKey && ev.shiftKey && !ev.metaKey) return "terminal.copy-selection";
  if (isV && ev.ctrlKey && ev.shiftKey && !ev.metaKey) return "terminal.paste";
  return null;
}
import { resolveHotkeyAction, type KeybindingMap } from "../../hotkeys/bindings";
