import { useEffect, useRef } from "react";

import type { AgentBackendConfig } from "../services/tauri/agentBackends";
import { getSessionUsage, prefetchCodexRateLimits } from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";
import type { UsageSnapshot } from "../types/usage";
import type { UsageIndicatorMode } from "../components/chat/composer/usageIndicatorMode";

interface SessionUsagePollerArgs {
  workspaceId: string | null;
  sessionId: string | null;
  backend: AgentBackendConfig | null;
  mode: UsageIndicatorMode;
  usageInsightsEnabled: boolean;
}

const REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes — fallback cadence

/**
 * Drive the unified `get_session_usage` snapshot for the active chat
 * session. No-ops while the indicator is hidden (`mode === "hidden"`)
 * so unsupported backends never touch the SQL aggregate or the
 * Anthropic OAuth path.
 *
 * Refresh signals:
 *  - immediate fetch on session / backend / mode change
 *  - re-fetch after each completed turn (so a Codex/OpenAI/Pi user
 *    doesn't sit at an empty meter for up to 5 min after their first
 *    response lands)
 *  - 5-min interval while the window is focused
 *  - paused on blur, resumed on focus (catching up if the interval
 *    elapsed during blur)
 *
 * Each `(workspaceId, sessionId)` switch evicts the prior session's
 * snapshot so the popover never flashes stale data from a sibling
 * tab — both on switch and on unmount.
 *
 * When `mode === "disabled"` (Claude-family backend with the experimental
 * Claude Code Usage flag off), we write a local stub snapshot into the
 * store instead of leaving any prior active snapshot in place. The
 * popover then reflects the disabled state correctly.
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
  // Turn-completion signal: when the count for this session changes, an
  // assistant turn landed and the chat_messages aggregate is stale.
  // We intentionally do NOT depend on streamingContent[sessionId].length:
  // it changes on every streamed chunk during a turn, which would
  // re-run this entire effect (and re-fire the synchronous placeholder
  // below) tens of times per second. The local-aggregate path reads
  // from persisted `chat_messages` rows that don't update until the
  // turn finalizes, so `completedTurnCount` is the correct signal.
  const completedTurnCount = useAppStore((s) =>
    sessionId ? (s.completedTurns[sessionId]?.length ?? 0) : 0,
  );

  // Track the previous (workspaceId, sessionId) so each switch can
  // evict its predecessor's snapshot. Using a ref (not state) so we
  // don't trigger an extra render — only the actual store mutation
  // does.
  const prevSessionRef = useRef<string | null>(null);

  // Track which (sessionId, backendKind) combinations have already
  // fired a Codex rate-limits prefetch this app run. Prevents a
  // duplicate Codex CLI spawn every time the effect re-runs (e.g. on
  // a new completed turn, a focus event, or a sibling-state update
  // that bumps a dep). Cleared implicitly on unmount via the ref's
  // own lifecycle.
  const prefetchedCodexKeysRef = useRef<Set<string>>(new Set());

  // Track the last (sessionId, backend.id) we wrote a synchronous
  // placeholder for. Without this, every effect re-run (e.g. when a
  // turn lands and `completedTurnCount` ticks) blanks the existing
  // snapshot's buckets back to `[]` and the meter flickers empty for
  // the ~50-200ms it takes the new fetch to land. We only want the
  // placeholder on actual session/backend transitions.
  const placeholderKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    if (mode === "hidden" || !workspaceId || !backend) {
      // Indicator isn't rendering — drop any prior snapshot for this
      // session so a later flip to "active" starts clean.
      clearSessionUsage(sessionId);
      return;
    }

    if (mode === "disabled") {
      // Claude-family backend, experimental flag off. Surface the
      // disabled stub so the popover reflects "off" rather than
      // showing a stale active snapshot from before the user toggled
      // the flag (or from when the session was on a different
      // backend).
      const stub: UsageSnapshot = {
        provider_kind: backend.kind,
        source_label: "Claude Code Usage off",
        buckets: [],
        note: "Enable Claude Code Usage in Settings → Experimental to surface subscription limits.",
        fetched_at_ms: Date.now(),
        experimental_disabled: true,
      };
      setSessionUsage(sessionId, stub);
      return;
    }

    // Synchronous placeholder on real backend transitions so the
    // indicator renders the new backend's chrome immediately instead
    // of disappearing for the ~50-200ms it takes the IPC + DB
    // roundtrip to land. Gate on `placeholderKeyRef` so a re-run
    // triggered purely by `completedTurnCount` (after a turn lands)
    // does NOT blank the existing buckets — it just lets `fetchOnce`
    // refresh them in place.
    const placeholderKey = `${sessionId}::${backend.id}::${backend.kind}`;
    if (placeholderKeyRef.current !== placeholderKey) {
      placeholderKeyRef.current = placeholderKey;
      setSessionUsage(sessionId, {
        provider_kind: backend.kind,
        source_label: backend.label,
        buckets: [],
        note: null,
        fetched_at_ms: Date.now(),
        experimental_disabled: false,
      });
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

    // First-time-on-this-session prefetch for Codex backends. The
    // backend's rate-limits cache is only populated as a side-effect
    // of starting a chat session — without this, the meter would
    // sit at local-aggregate until the user sent their first turn,
    // which felt like "I have to send a message before my plan
    // shows up." The prefetch spawns a short-lived Codex app-server
    // session in the background and tears it down once the
    // `account/rateLimits/read` returns.
    const isCodexBackend =
      backend.kind === "codex_native" || backend.kind === "codex_subscription";
    if (isCodexBackend) {
      const prefetchKey = `${sessionId}::${backend.kind}::${backend.id}`;
      if (!prefetchedCodexKeysRef.current.has(prefetchKey)) {
        prefetchedCodexKeysRef.current.add(prefetchKey);
        // Fire and forget; the resolve handler triggers a re-fetch so
        // the freshly-cached snapshot lands without waiting for the
        // 5-min poller tick.
        void prefetchCodexRateLimits(backend).then(() => {
          if (cancelled) return;
          void fetchOnce();
        });
      }
    }

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
    // `completedTurnCount` is intentionally in the deps so the effect
    // re-runs (and immediately fetches) whenever a new assistant turn
    // lands for the active session. We intentionally do not depend on
    // mid-stream signals — local-aggregate rows aren't written until
    // the turn finalizes, and remote sources have their own push
    // (Codex rate-limit notifications) or interval (Anthropic OAuth)
    // updates that don't need a per-chunk re-poll.
  }, [
    workspaceId,
    sessionId,
    backend,
    mode,
    usageInsightsEnabled,
    completedTurnCount,
    setSessionUsage,
    clearSessionUsage,
  ]);

  // Cross-effect eviction: when the active session id changes, drop the
  // previous session's snapshot from the store so the popover for a
  // freshly-switched tab can't briefly render the prior session's data.
  // The unmount cleanup below handles tab close.
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev && prev !== sessionId) {
      clearSessionUsage(prev);
    }
    prevSessionRef.current = sessionId;
  }, [sessionId, clearSessionUsage]);

  useEffect(() => {
    // Drop the snapshot on full unmount so a remount (HMR, route
    // change, workspace teardown) starts with no stale data.
    return () => {
      const prev = prevSessionRef.current;
      if (prev) clearSessionUsage(prev);
    };
  }, [clearSessionUsage]);
}
