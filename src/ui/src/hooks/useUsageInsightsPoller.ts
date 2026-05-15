import { useEffect } from "react";
import { useAppStore } from "../stores/useAppStore";
import { getClaudeCodeUsage } from "../services/tauri";

const REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes

/**
 * Keeps `claudeCodeUsage` fresh in the store while Usage Insights is enabled.
 *
 * Fetches once on enable and then every 5 minutes. The Anthropic usage API
 * is per-account, not per-workspace, so a single global poller is correct —
 * the indicator and Settings panel both read the same value. Failures are
 * swallowed: the Settings panel surfaces auth/error states itself, and a
 * transient network blip should not be loud here.
 */
export function useUsageInsightsPoller() {
  const enabled = useAppStore((s) => s.usageInsightsEnabled);
  const setUsage = useAppStore((s) => s.setClaudeCodeUsage);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const data = await getClaudeCodeUsage();
        if (!cancelled) setUsage(data);
      } catch {
        // Ignore — Settings panel handles error display.
      }
    };

    void fetchOnce();
    const id = setInterval(fetchOnce, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, setUsage]);
}
