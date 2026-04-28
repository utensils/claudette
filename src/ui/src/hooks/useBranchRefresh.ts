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
 * Poll all active workspaces for external branch-name drift and mirror any
 * detected changes into the Zustand store. Errors are swallowed so a
 * transient git/IPC failure doesn't break the polling loop. Returns the
 * number of drift entries applied so the caller can adapt its cadence.
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
  } catch {
    // Silently ignore refresh errors
    return 0;
  }
}

/**
 * Immediate refresh for a single workspace — called when the user selects
 * one so external renames appear without waiting on the poll. Returns
 * the new branch name if one was applied (useful for tests).
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
  } catch {
    return null;
  }
}

function isWindowVisible(): boolean {
  if (typeof document === "undefined") return true;
  return !document.hidden;
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
      // Skip the network round-trip when the window is hidden — no UI is
      // visible to update, and waking up again on visibilitychange will
      // refresh immediately. Reschedule a check at the back-off cap so we
      // catch up shortly after the window comes back without spamming.
      if (!isWindowVisible()) {
        schedule(BRANCH_POLL_MAX_MS);
        return;
      }
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

    const onVisible = () => {
      // Returning to visible: reset back-off and refresh now so the user
      // sees current state without waiting on the (possibly long) timer.
      if (!isWindowVisible()) return;
      consecutiveEmpty = 0;
      void tick();
    };
    const onFocus = () => onVisible();
    const onBlur = () => {
      // No need to immediately cancel — the next tick will see the hidden
      // state and bail. But cancel anyway so a near-due timer doesn't
      // perform a pointless probe right after blur.
      clearTimer();
      schedule(BRANCH_POLL_MAX_MS);
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);

    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
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
