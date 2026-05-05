/** Voice hotkey constants and platform helpers.
 *
 * This file is intentionally small and dependency-free (no React, no Zustand)
 * so it can be imported by both the hook (`useVoiceHotkey.ts`) and the
 * settings slice (`settingsSlice.ts`) without creating a circular dependency.
 */

export const DEFAULT_TOGGLE_HOTKEY = "mod+shift+m";

/** macOS-only default hold key. On Windows/Linux the same physical key is
 * frequently bound to AltGr (used to type @, {}, ñ, ç, etc.), so binding
 * voice input to it would break common text entry. Use null elsewhere and
 * let users opt in via Settings → Keyboard. */
export const DEFAULT_HOLD_HOTKEY_MAC = "AltRight";

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
}

/** Platform-aware default for the hold-to-talk key. */
export function getDefaultHoldHotkey(): string | null {
  return isMacPlatform() ? DEFAULT_HOLD_HOTKEY_MAC : null;
}
