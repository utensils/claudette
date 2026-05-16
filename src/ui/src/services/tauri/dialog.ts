import { invoke } from "@tauri-apps/api/core";

/**
 * Probe whether a native file-picker backend is reachable on this
 * host. On macOS / Windows this returns true unconditionally; on
 * Linux it succeeds only when an xdg-desktop-portal daemon is
 * running with a FileChooser-capable backend (xdg-desktop-portal-
 * gtk, -gnome, -kde, etc.). When this returns false, Browse
 * buttons should be hidden — calling `open()` from
 * `@tauri-apps/plugin-dialog` against a missing portal crashes
 * the host process (no JS-level try/catch can recover).
 *
 * The backend caches the result for the process lifetime, so this
 * is cheap to call from anywhere. We hit it once at app boot
 * and store the answer in the Zustand store.
 */
export function fileDialogCapability(): Promise<boolean> {
  return invoke<boolean>("file_dialog_capability");
}
