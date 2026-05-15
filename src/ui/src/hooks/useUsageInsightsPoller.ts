import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { getClaudeCodeUsage } from "../services/tauri";

const REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes

/**
 * Keeps `claudeCodeUsage` fresh in the store while Usage Insights is enabled
 * AND the app window is focused.
 *
 * Polling pauses whenever the user switches to another app or minimizes the
 * window — no point spending API calls (and rate-limit budget) on usage data
 * the user can't see. On refocus, if more than REFRESH_INTERVAL_MS has elapsed
 * since the last successful fetch, we fetch immediately; otherwise we resume
 * the existing schedule.
 *
 * The schedule is a self-rescheduling `setTimeout` rather than `setInterval`
 * so the next fetch is always REFRESH_INTERVAL_MS after the previous one
 * *resolved*, not after it was kicked off. A slow request can't pull the next
 * one closer than intended.
 *
 * The Anthropic usage API is per-account, not per-workspace, so a single
 * global poller is correct — the indicator and Settings panel both read the
 * same value. Failures are swallowed: the Settings panel surfaces auth/error
 * states itself, and a transient network blip should not be loud here.
 */
export function useUsageInsightsPoller() {
  const enabled = useAppStore((s) => s.usageInsightsEnabled);
  const setUsage = useAppStore((s) => s.setClaudeCodeUsage);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastFetchAt = 0;

    const fetchOnce = async () => {
      try {
        const data = await getClaudeCodeUsage();
        if (cancelled) return;
        setUsage(data);
        lastFetchAt = Date.now();
      } catch {
        // Ignore — Settings panel handles error display.
      }
    };

    const stop = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const scheduleNext = (delay: number) => {
      if (timeoutId !== null) return;
      timeoutId = setTimeout(async () => {
        timeoutId = null;
        if (cancelled) return;
        // Defensive: if focus flipped during the wait, the blur handler has
        // already cleared this timeout — but in the unlikely race where the
        // callback fires before the listener, skip the fetch.
        if (!document.hasFocus()) return;
        await fetchOnce();
        if (cancelled) return;
        scheduleNext(REFRESH_INTERVAL_MS);
      }, delay);
    };

    const start = () => {
      if (timeoutId !== null) return; // already scheduled
      const elapsed = Date.now() - lastFetchAt;
      if (lastFetchAt === 0 || elapsed >= REFRESH_INTERVAL_MS) {
        // First run, or the interval already elapsed during blur — catch up
        // now, then schedule the next fetch from the completion time.
        void fetchOnce().then(() => {
          if (!cancelled) scheduleNext(REFRESH_INTERVAL_MS);
        });
      } else {
        // Resume the existing schedule: fire once when the remaining time
        // expires, then settle into the steady 5-min cadence after that.
        scheduleNext(REFRESH_INTERVAL_MS - elapsed);
      }
    };

    const handleFocus = () => {
      if (cancelled) return;
      start();
    };
    const handleBlur = () => {
      stop();
    };

    if (document.hasFocus()) start();
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      cancelled = true;
      stop();
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, [enabled, setUsage]);
}
