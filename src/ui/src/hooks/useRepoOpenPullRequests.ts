import { useCallback, useEffect, useRef, useState } from "react";
import {
  listRepoOpenPullRequests,
  refreshRepoScmLists,
} from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";
import type {
  PullRequestScope,
  RepoPullRequestsPayload,
} from "../types/plugin";

const POLL_INTERVAL_MS = 60_000;

export interface UseRepoOpenPullRequestsResult {
  /// Payload for the requested scope. When the new scope hasn't been
  /// fetched yet, the hook falls back to the most recent payload seen
  /// for any other scope (stale-while-revalidate) so the section can
  /// keep rendering rows during the round-trip instead of flashing a
  /// blank list. Mirrors the same behaviour in `useRepoOpenIssues`.
  payload: RepoPullRequestsPayload | undefined;
  /// True when the returned `payload` is from a different scope than
  /// the one currently requested.
  isStale: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

/// Subscribe a project-view section to its repo's open PRs for a given
/// scope (open / mine / review_requested). Mirrors
/// `useRepoOpenIssues` — see that hook for the polling / visibility
/// contract.
export function useRepoOpenPullRequests(
  repoId: string | null,
  scope: PullRequestScope,
): UseRepoOpenPullRequestsResult {
  const enabled = useAppStore((s) => s.projectViewIssuesPrsEnabled);
  const payload = useAppStore((s) =>
    repoId ? s.repoPullRequestsByRepoId[repoId]?.[scope] : undefined,
  );
  const setRepoPullRequests = useAppStore((s) => s.setRepoPullRequests);
  const [loading, setLoading] = useState(false);

  const activeRepoRef = useRef<string | null>(repoId);
  const activeScopeRef = useRef<PullRequestScope>(scope);
  useEffect(() => {
    activeRepoRef.current = repoId;
    activeScopeRef.current = scope;
  }, [repoId, scope]);

  const fetchOnce = useCallback(async () => {
    if (!enabled || !repoId) return;
    setLoading(true);
    try {
      const next = await listRepoOpenPullRequests(repoId, scope);
      if (
        activeRepoRef.current === repoId &&
        activeScopeRef.current === scope
      ) {
        setRepoPullRequests(repoId, scope, next);
      }
    } catch {
      // Same contract as the issues hook: errors keep prior state.
    } finally {
      // Only the request for the *current* repo + scope owns `loading` —
      // a stale response after a repo/scope switch must not clear the
      // spinner for the request now in flight (mirrors the store-write
      // guard above).
      if (
        activeRepoRef.current === repoId &&
        activeScopeRef.current === scope
      ) {
        setLoading(false);
      }
    }
  }, [enabled, repoId, scope, setRepoPullRequests]);

  const refresh = useCallback(async () => {
    if (!enabled || !repoId) return;
    try {
      await refreshRepoScmLists(repoId);
    } catch {
      // best-effort
    }
    await fetchOnce();
  }, [enabled, repoId, fetchOnce]);

  useEffect(() => {
    if (!enabled || !repoId) return;
    let cancelled = false;

    void fetchOnce();

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

  // Stale-while-revalidate fallback — see useRepoOpenIssues for the
  // full rationale. Without this, switching scope tabs flashes a
  // skeleton during the fetch round-trip; with it, the section keeps
  // showing the previous scope's rows until real data lands.
  const byScope = useAppStore((s) =>
    repoId ? s.repoPullRequestsByRepoId[repoId] : undefined,
  );
  const lastSeenRef = useRef<RepoPullRequestsPayload | undefined>(undefined);
  if (payload) {
    lastSeenRef.current = payload;
  } else if (byScope) {
    let freshest: RepoPullRequestsPayload | undefined;
    for (const candidate of Object.values(byScope)) {
      if (!candidate) continue;
      if (!freshest || candidate.fetched_at > freshest.fetched_at) {
        freshest = candidate;
      }
    }
    if (freshest) lastSeenRef.current = freshest;
  }

  const effectivePayload = payload ?? lastSeenRef.current;
  const isStale = !payload && effectivePayload !== undefined;

  return { payload: effectivePayload, isStale, loading, refresh };
}
