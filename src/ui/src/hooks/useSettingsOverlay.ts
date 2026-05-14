import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";

/**
 * Register a dismissible overlay inside Settings while `active` is true.
 *
 * The global Escape handler in `useKeyboardShortcuts` peels off layers in
 * priority order: when `settingsOverlayCount > 0` it returns instead of
 * closing Settings, so the component's own Escape handler can close its
 * popover/modal first. Only when no inner overlay is registered does Escape
 * exit Settings.
 */
export function useSettingsOverlay(active: boolean) {
  const push = useAppStore((s) => s.pushSettingsOverlay);
  const pop = useAppStore((s) => s.popSettingsOverlay);
  useEffect(() => {
    if (!active) return;
    push();
    return () => pop();
  }, [active, push, pop]);
}
