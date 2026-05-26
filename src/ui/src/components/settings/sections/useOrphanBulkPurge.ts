import { useCallback, useRef, useState } from "react";
import { purgeOrphanedWorktree } from "../../../services/tauri";

export interface BulkPurgeProgress {
  done: number;
  total: number;
}

export interface BulkPurgeResult {
  failures: { path: string; error: unknown }[];
  skipped: number;
  total: number;
}

interface UseOrphanBulkPurgeOpts {
  /** Fires after each individual path completes (success only) so the
   *  caller can evict it from the visible orphans list immediately. */
  onPathPurged: (path: string) => void;
  /** Fires once when the whole batch finishes (succeeded, failed, or
   *  cancelled). The caller uses this to refresh aggregate state (e.g.
   *  re-pull `compute_storage_stats`) and to render a summary. */
  onComplete: (result: BulkPurgeResult) => void;
}

/**
 * Sequential bulk-purge state machine extracted from `StorageSettings`.
 *
 * - **Sequential**, not `Promise.all` — keeps the user's progress
 *   readout accurate (`1/N`, `2/N`, …) and avoids spawning N concurrent
 *   `remove_dir_all`s against the same parent dir.
 * - **Cooperative cancel** via a ref the loop checks at the top of each
 *   iteration. The currently-running `purgeOrphanedWorktree` call is
 *   allowed to finish (the backend's `remove_dir_all` is not safely
 *   interruptible) but no further paths are touched. Matches the spec
 *   for "Cancel preserves remaining items."
 * - The hook owns `purging`, `bulkProgress`, and `bulkCancelling`
 *   exclusively; the caller only consumes them for rendering and is
 *   not allowed to mutate them.
 */
export function useOrphanBulkPurge({
  onPathPurged,
  onComplete,
}: UseOrphanBulkPurgeOpts) {
  const [purging, setPurging] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<BulkPurgeProgress | null>(
    null,
  );
  const [bulkCancelling, setBulkCancelling] = useState(false);
  // Ref instead of state so the loop closure sees the latest cancel
  // flag without setState → re-render → new-closure churn.
  const cancelRef = useRef(false);

  const start = useCallback(
    async (paths: string[]) => {
      cancelRef.current = false;
      setBulkCancelling(false);
      setPurging((prev) => {
        const next = new Set(prev);
        for (const p of paths) next.add(p);
        return next;
      });
      setBulkProgress({ done: 0, total: paths.length });

      const failures: { path: string; error: unknown }[] = [];
      let done = 0;
      let skipped = 0;
      for (const path of paths) {
        if (cancelRef.current) {
          skipped = paths.length - done;
          break;
        }
        try {
          await purgeOrphanedWorktree(path);
          onPathPurged(path);
        } catch (e) {
          failures.push({ path, error: e });
        }
        done++;
        setBulkProgress({ done, total: paths.length });
      }

      setPurging((prev) => {
        const next = new Set(prev);
        for (const p of paths) next.delete(p);
        return next;
      });
      setBulkProgress(null);
      setBulkCancelling(false);
      cancelRef.current = false;

      onComplete({ failures, skipped, total: paths.length });
    },
    [onPathPurged, onComplete],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
    setBulkCancelling(true);
  }, []);

  return { purging, bulkProgress, bulkCancelling, start, cancel };
}
