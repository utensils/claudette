import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { refreshBranches, refreshWorkspaceBranch } from "../services/tauri";
import type { Workspace } from "../types/workspace";

type UpdateWorkspace = (id: string, updates: Partial<Workspace>) => void;

/** Base poll interval when the window is focused and we have just observed drift. */
export const BRANCH_POLL_BASE_MS = 5_000;
/** Upper bound for back-off when consecutive polls report no drift. */
export const BRANCH_POLL_MAX_MS = 30_000;

/**
 * Compute the next poll delay given how many consecutive polls have come back
 * empty. Doubles from the base on each empty tick (5s → 10s → 20s → 30s cap).
 * Reset to base any time drift is observed or the window regains focus.
 */
export function nextBranchPollDelay(consecutiveEmpty: number): number {
  if (consecutiveEmpty <= 0) return BRANCH_POLL_BASE_MS;
  const grown = BRANCH_POLL_BASE_MS * 2 ** consecutiveEmpty;
  return Math.min(grown, BRANCH_POLL_MAX_MS);
}

/**
 * Poll all active workspaces and mirror the backend-reported branch into the
 * Zustand store. The backend returns one entry per active workspace
 * (level-triggered, see issue 538), so this also self-heals a store that
 * has somehow drifted from the DB. Errors are caught so a transient git/IPC
 * failure doesn't break the polling loop, but they're surfaced to the
 * console so the failure mode isn't invisible. Returns the number of
 * entries applied so the caller can adapt its cadence.
 */
export async function pollAndApplyBranchUpdates(
  updateWorkspace: UpdateWorkspace,
): Promise<number> {
  try {
    const updates = await refreshBranches();
    for (const [wsId, branchName] of updates) {
      updateWorkspace(wsId, { branch_name: branchName });
    }
    return updates.length;
  } catch (err) {
    console.warn("[branch-refresh] poll failed:", err);
    return 0;
  }
}

/**
 * Immediate refresh for a single workspace — called when the user selects
 * one so external renames appear without waiting on the poll. The backend
 * returns the current branch (not just on drift) per issue 538, so any
 * non-null value is written through to the store unconditionally. Returns
 * the resolved branch (or `null` if the backend couldn't determine one).
 */
export async function refreshSelectedWorkspaceBranch(
  workspaceId: string,
  updateWorkspace: UpdateWorkspace,
): Promise<string | null> {
  try {
    const branch = await refreshWorkspaceBranch(workspaceId);
    if (branch !== null) {
      updateWorkspace(workspaceId, { branch_name: branch });
    }
    return branch;
  } catch (err) {
    console.warn(
      `[branch-refresh] single refresh failed for ${workspaceId}:`,
      err,
    );
    return null;
  }
}

function isAppActive(): boolean {
  if (typeof document === "undefined") return true;
  // Treat both hidden tabs (`document.hidden`) and unfocused-but-visible
  // windows (`!document.hasFocus()`) as inactive. On macOS the user
  // commonly Cmd-Tabs to another app — that blurs the window without
  // hiding the document, so a hidden-only check would still poll there.
  return !document.hidden && document.hasFocus();
}

export function useBranchRefresh() {
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveEmpty = 0;
    let inFlight = false;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (delay: number) => {
      clearTimer();
      if (cancelled) return;
      timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      timer = null;
      if (cancelled) return;
      // Skip the network round-trip when the app is inactive — no UI is
      // visible to update, and waking up on focus/visibility will refresh
      // immediately. Holding the timer empty (instead of rescheduling)
      // means a backgrounded window won't keep firing pointless probes;
      // the focus/visibility handler is the single source of resumption.
      if (!isAppActive()) return;
      if (inFlight) {
        schedule(BRANCH_POLL_BASE_MS);
        return;
      }
      inFlight = true;
      const applied = await pollAndApplyBranchUpdates(updateWorkspace);
      inFlight = false;
      if (cancelled) return;
      consecutiveEmpty = applied > 0 ? 0 : consecutiveEmpty + 1;
      schedule(nextBranchPollDelay(consecutiveEmpty));
    };

    // Run immediately on mount, then enter the back-off loop.
    void tick();

    const onResume = () => {
      // App became active again: cancel any pending timer (otherwise we'd
      // double-poll once the focus-driven `tick` schedules its own next
      // delay), reset the back-off, and refresh now.
      if (!isAppActive()) return;
      clearTimer();
      consecutiveEmpty = 0;
      void tick();
    };
    const onPause = () => {
      // App went inactive — stop the timer outright. Resumption goes
      // through `onResume`, which re-arms the loop.
      clearTimer();
    };

    const onVisibilityChange = () => {
      if (isAppActive()) onResume();
      else onPause();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onResume);
    window.addEventListener("blur", onPause);

    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("blur", onPause);
    };
  }, [updateWorkspace]);

  // Immediate refresh when the user selects a workspace — picks up branch
  // renames done in the integrated terminal without waiting for the next
  // poll tick.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    refreshSelectedWorkspaceBranch(selectedWorkspaceId, updateWorkspace);
  }, [selectedWorkspaceId, updateWorkspace]);
}
