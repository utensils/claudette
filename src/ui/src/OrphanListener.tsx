import { useEffect } from "react";

import { useAppStore } from "./stores/useAppStore";
import {
  cleanupOrphans,
  subscribeOrphansDetected,
  type OrphansDetectedEvent,
} from "./services/interactive";

/**
 * Mounts the one-shot boot-time `interactive://orphans-detected`
 * listener emitted by `claudette::interactive_lifecycle`. The event
 * fires when the host (tmux / sidecar) reports `claudette-` sessions
 * Claudette's DB doesn't track — typically left over from a previous
 * Claudette process that crashed.
 *
 * On receipt we:
 *   1. Surface a one-shot toast so the user knows something
 *      recoverable happened.
 *   2. Automatically invoke `cleanupOrphans` to stop the orphan
 *      sessions. The Rust side clears its orphan map either way, so a
 *      failed cleanup is logged but not re-tried — a second toast won't
 *      reappear on the next boot.
 *
 * Lives as a sibling of `App.tsx` (rather than inline in App's giant
 * effect) so the lifecycle can be tested in isolation without bringing
 * the rest of App's provider graph along — see `App.orphans.test.tsx`.
 */
export function OrphanListener(): null {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const handle = (payload: OrphansDetectedEvent): void => {
      const sids = payload?.sids ?? [];
      if (sids.length === 0) return;
      console.warn(
        `[interactive] detected ${sids.length} orphan session(s) on the host:`,
        sids,
        "— invoke interactive_cleanup_orphans to stop them.",
      );
      const store = useAppStore.getState();
      store.addToast(
        `Cleaning up ${sids.length} orphan interactive session${sids.length === 1 ? "" : "s"} from a previous run.`,
      );
      cleanupOrphans()
        .then((stopped) => {
          console.info(
            `[interactive] cleaned up ${stopped.length} of ${sids.length} orphan session(s)`,
            stopped,
          );
        })
        .catch((err) => {
          console.error("[interactive] cleanupOrphans failed", err);
        });
    };

    void subscribeOrphansDetected(handle)
      .then((fn) => {
        if (cancelled) {
          // Listener resolved after unmount — drop it immediately.
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err) => {
        console.warn("[OrphanListener] subscribeOrphansDetected failed:", err);
      });

    return () => {
      cancelled = true;
      if (unlisten !== null) unlisten();
    };
  }, []);

  return null;
}
