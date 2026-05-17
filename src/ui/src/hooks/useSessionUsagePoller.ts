import { useEffect } from "react";

import type { AgentBackendConfig } from "../services/tauri/agentBackends";
import { getSessionUsage } from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";
import type { UsageIndicatorMode } from "../components/chat/composer/usageIndicatorMode";

interface SessionUsagePollerArgs {
  workspaceId: string | null;
  sessionId: string | null;
  backend: AgentBackendConfig | null;
  mode: UsageIndicatorMode;
  usageInsightsEnabled: boolean;
}

const REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes — same as the legacy poller

/**
 * Drive the unified `get_session_usage` snapshot for the active chat
 * session. No-ops while the indicator is hidden (`mode === "hidden"`)
 * so unsupported backends never touch the SQL aggregate or the
 * Anthropic OAuth path.
 *
 * Refresh is event-driven plus a 5-minute fallback:
 *  - immediate fetch on session / backend / mode change,
 *  - 5-min interval while the window is focused,
 *  - paused on blur, resumed on focus (catching up if the interval
 *    elapsed during blur).
 *
 * Each `(workspaceId, sessionId)` switch evicts the prior session's
 * snapshot so the popover never flashes stale data from a sibling tab.
 */
export function useSessionUsagePoller({
  workspaceId,
  sessionId,
  backend,
  mode,
  usageInsightsEnabled,
}: SessionUsagePollerArgs) {
  const setSessionUsage = useAppStore((s) => s.setSessionUsage);
  const clearSessionUsage = useAppStore((s) => s.clearSessionUsage);

  useEffect(() => {
    if (mode === "hidden" || !workspaceId || !sessionId || !backend) {
      return;
    }
    if (mode === "disabled") {
      // Surface the stub snapshot so the popover stays empty without
      // hitting the backend. Skip the poll entirely.
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastFetchAt = 0;
    let inFlight: Promise<void> | null = null;

    const fetchOnce = (): Promise<void> => {
      if (inFlight !== null) return inFlight;
      inFlight = (async () => {
        try {
          const snapshot = await getSessionUsage({
            workspaceId,
            chatSessionId: sessionId,
            backend,
            usageInsightsEnabled,
            openrouterApiKey: null,
          });
          if (cancelled) return;
          setSessionUsage(sessionId, snapshot);
          lastFetchAt = Date.now();
        } catch {
          // Settings UI surfaces auth/error states for the gated path;
          // the indicator stays empty until the next poll cycle.
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
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
        if (!document.hasFocus()) return;
        await fetchOnce();
        if (cancelled) return;
        scheduleNext(REFRESH_INTERVAL_MS);
      }, delay);
    };

    const start = () => {
      if (timeoutId !== null) return;
      const elapsed = Date.now() - lastFetchAt;
      if (lastFetchAt === 0 || elapsed >= REFRESH_INTERVAL_MS) {
        void fetchOnce().then(() => {
          if (!cancelled) scheduleNext(REFRESH_INTERVAL_MS);
        });
      } else {
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
  }, [
    workspaceId,
    sessionId,
    backend,
    mode,
    usageInsightsEnabled,
    setSessionUsage,
    clearSessionUsage,
  ]);
}
