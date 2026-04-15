/**
 * Focus helpers for the Cmd+` / Cmd+0 chat↔terminal focus toggle.
 *
 * These are DOM-level lookups rather than React refs because the global
 * keyboard-shortcut handler in `useKeyboardShortcuts.ts` runs outside the
 * component tree, and the xterm helper textarea is owned by xterm.js, not
 * React. Keeping the lookups centralized here means the selectors appear
 * exactly once and can be unit-tested in isolation.
 */

const CHAT_INPUT_SELECTOR = "textarea[data-chat-input]";
/** xterm.js renders a hidden textarea that receives keyboard input. */
const XTERM_HELPER_SELECTOR = ".xterm-helper-textarea";
/** The container class xterm wraps every Terminal instance in. */
const XTERM_CONTAINER_SELECTOR = ".xterm";

/**
 * Focus the chat prompt textarea if it's in the DOM.
 * Returns whether focus was actually placed — callers use this to decide
 * whether to fall back to another target.
 */
export function focusChatPrompt(doc: Document = document): boolean {
  const el = doc.querySelector<HTMLTextAreaElement>(CHAT_INPUT_SELECTOR);
  if (!el) return false;
  el.focus();
  return true;
}

/**
 * Focus the xterm helper textarea of the currently visible terminal tab.
 * Inactive tab containers have `display: none`, so their textareas have a
 * null `offsetParent` — this picks the first one that isn't hidden.
 */
export function focusActiveTerminal(doc: Document = document): boolean {
  const helpers = doc.querySelectorAll<HTMLTextAreaElement>(XTERM_HELPER_SELECTOR);
  for (const el of Array.from(helpers)) {
    if ((el as HTMLElement).offsetParent !== null) {
      el.focus();
      return true;
    }
  }
  // Fallback: first helper in the DOM (jsdom doesn't compute layout, so
  // offsetParent is always null there — this keeps the helpers testable).
  if (helpers.length > 0) {
    helpers[0].focus();
    return true;
  }
  return false;
}

/**
 * True when focus currently lives inside an xterm terminal instance.
 * Used by Cmd+0 to decide which direction to toggle.
 */
export function isTerminalFocused(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (!active) return false;
  return !!(active as HTMLElement).closest?.(XTERM_CONTAINER_SELECTOR);
}
