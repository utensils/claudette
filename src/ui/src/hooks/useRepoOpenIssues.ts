import { useCallback, useEffect, useRef, useState } from "react";
import { listRepoOpenIssues, refreshRepoScmLists } from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";
import type { RepoIssuesPayload } from "../types/plugin";

/// Polling cadence for the repo-wide lists. Deliberately slower than the
/// per-workspace SCM cache (10s) — a project-view list view doesn't need
/// real-time freshness and the longer interval keeps Claudette a polite
/// GitHub-rate-limit citizen.
const POLL_INTERVAL_MS = 60_000;

export interface UseRepoOpenIssuesResult {
  payload: RepoIssuesPayload | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
}

/// Subscribe a project-view section to its repo's open issues.
///
/// Behavior:
///  - When the feature flag is off, returns an empty payload and never
///    invokes the Tauri command (the backend short-circuits as well — this
///    is just to avoid the no-op round-trip).
///  - Polls every 60s while the document is visible. Pauses on
///    `visibilitychange` to `hidden` and resumes when the tab returns.
///  - Auto-cancels on repo switch — the cleanup effect drops the pending
///    timeout for the previous repo so a delayed response can't write
///    stale data into the store under a different repo's key.
export function useRepoOpenIssues(repoId: string | null): UseRepoOpenIssuesResult {
  const enabled = useAppStore((s) => s.projectViewIssuesPrsEnabled);
  const payload = useAppStore((s) =>
    repoId ? s.repoIssuesByRepoId[repoId] : undefined,
  );
  const setRepoIssues = useAppStore((s) => s.setRepoIssues);
  const [loading, setLoading] = useState(false);

  // Track the active repoId via ref so the polling tick can early-return if
  // the user has navigated away mid-flight.
  const activeRepoRef = useRef<string | null>(repoId);
  useEffect(() => {
    activeRepoRef.current = repoId;
  }, [repoId]);

  const fetchOnce = useCallback(async () => {
    if (!enabled || !repoId) return;
    setLoading(true);
    try {
      const next = await listRepoOpenIssues(repoId);
      if (activeRepoRef.current === repoId) {
        setRepoIssues(repoId, next);
      }
    } catch {
      // Backend already preserves prior payload on transient errors; a
      // hard failure here (e.g. tauri channel dropped) leaves the store
      // alone so the UI shows the last good state.
    } finally {
      setLoading(false);
    }
  }, [enabled, repoId, setRepoIssues]);

  const refresh = useCallback(async () => {
    if (!enabled || !repoId) return;
    try {
      await refreshRepoScmLists(repoId);
    } catch {
      // Refresh is best-effort — if dropping the cache fails the next
      // fetch will still hit the plugin and overwrite stale state.
    }
    await fetchOnce();
  }, [enabled, repoId, fetchOnce]);

  useEffect(() => {
    if (!enabled || !repoId) return;
    let cancelled = false;

    // Initial fetch.
    void fetchOnce();

    // Polling loop — uses setTimeout chain rather than setInterval so a
    // visibility pause leaves no overlapping in-flight requests when the
    // tab returns.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      await fetchOnce();
      if (cancelled) return;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchOnce();
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, repoId, fetchOnce]);

  return { payload, loading, refresh };
}
