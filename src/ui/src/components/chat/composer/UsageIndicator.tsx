import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAppStore } from "../../../stores/useAppStore";
import { useSessionUsagePoller } from "../../../hooks/useSessionUsagePoller";
import type { UsageBucket } from "../../../types/usage";
import { CLAUDE_CODE_USAGE_FOCUS } from "../../settings/focusKeys";
import { resolveIndicatorMode } from "./usageIndicatorMode";
import { UsagePopover } from "./UsagePopover";
import styles from "./UsageIndicator.module.css";

interface UsageIndicatorProps {
  workspaceId: string | null;
  sessionId: string | null;
}

function barColor(pct: number): string {
  if (pct >= 0.85) return "var(--status-stopped)";
  if (pct >= 0.6) return "var(--context-meter-warn)";
  return "var(--accent-primary)";
}

/** Pick the bucket the compact indicator should surface. Bounded
 *  buckets (subscription quotas, OpenRouter credits) win — they have a
 *  concrete cap and an `exhausted` state worth showing. Within bounded
 *  buckets the highest utilization wins. If there are no bounded
 *  buckets, fall back to the first unbounded bucket so the indicator
 *  still has something to render. */
function pickIndicatorBucket(buckets: UsageBucket[]): UsageBucket | null {
  if (buckets.length === 0) return null;
  const bounded = buckets.filter((b) => b.is_bounded);
  if (bounded.length > 0) {
    return bounded.reduce((best, b) =>
      b.utilization > best.utilization ? b : best,
    );
  }
  return buckets[0];
}

/**
 * Compact usage-allocation indicator for the composer toolbar.
 *
 * Rendered for every chat session — the per-backend
 * [`resolveIndicatorMode`](./usageIndicatorMode.ts) decides whether
 * the meter is live, greyed-out-pending-opt-in (Claude family), or
 * hidden entirely (unknown backend kind). Click opens the popover
 * for live indicators, or jumps to Settings → Experimental for the
 * disabled variant.
 */
export function UsageIndicator({ workspaceId, sessionId }: UsageIndicatorProps) {
  const { t } = useTranslation("settings");

  const usageInsightsEnabled = useAppStore((s) => s.usageInsightsEnabled);
  const agentBackends = useAppStore((s) => s.agentBackends);
  const defaultAgentBackendId = useAppStore((s) => s.defaultAgentBackendId);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const selectedModelProvider = useAppStore((s) => s.selectedModelProvider);
  const sessionUsage = useAppStore((s) => s.sessionUsage);
  const openSettings = useAppStore((s) => s.openSettings);

  const backend = useMemo(() => {
    if (!sessionId) return null;
    // Match the backend resolution used by the send/runtime path:
    // per-session provider -> configured default backend -> first
    // loaded backend. A hardcoded "anthropic" fallback makes Codex or
    // OpenRouter defaults look gated by the Claude Code Usage toggle.
    const backendId = selectedModelProvider[sessionId] ?? defaultAgentBackendId;
    return (
      agentBackends.find((b) => b.id === backendId) ??
      agentBackends.find((b) => b.id === defaultAgentBackendId) ??
      agentBackends[0] ??
      null
    );
  }, [agentBackends, defaultAgentBackendId, selectedModelProvider, sessionId]);

  const usageBackend = useMemo(() => {
    if (!backend || !sessionId) return backend;
    const model = selectedModel[sessionId];
    if (!model || backend.default_model === model) return backend;
    return { ...backend, default_model: model };
  }, [backend, selectedModel, sessionId]);

  const mode = resolveIndicatorMode(usageBackend, usageInsightsEnabled);
  const snapshot = sessionId ? sessionUsage[sessionId] : null;

  // Drive the per-session poll on the active session. The hook
  // no-ops when `mode === "hidden"` so unsupported backends don't
  // spin up DB aggregates.
  useSessionUsagePoller({
    workspaceId,
    sessionId,
    backend: usageBackend,
    mode,
    usageInsightsEnabled,
  });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // Re-render once a minute so any future reset countdowns stay fresh
  // without leaning on every render of the composer.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (mode !== "active") return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [mode]);

  if (mode === "hidden") return null;

  if (mode === "disabled") {
    const label = t("usage_indicator_disabled_tooltip", {
      defaultValue: "Claude Code Usage is off — click to enable",
    });
    return (
      <div className={styles.wrapper}>
        <button
          ref={triggerRef}
          type="button"
          className={`${styles.indicator} ${styles.disabled}`}
          title={label}
          aria-label={label}
          onClick={() => openSettings("experimental", CLAUDE_CODE_USAGE_FOCUS)}
        >
          <div className={styles.bar}>
            <div className={styles.barFill} />
          </div>
          <span className={styles.readout}>—</span>
        </button>
      </div>
    );
  }

  // Active. Wait for the first snapshot before painting — the poller
  // resolves it within a single tick, so the gap is invisible.
  if (!snapshot) return null;

  // Empty-bucket case: the snapshot loaded but the source had nothing
  // to surface yet (e.g. a brand-new Codex session with zero recorded
  // turns). Render an empty bar so the user can still open the popover
  // and read `snapshot.note` ("No turns recorded yet…"). Without this
  // the meter silently disappears on every first turn.
  const bucket = pickIndicatorBucket(snapshot.buckets);
  const pct = bucket?.is_bounded ? Math.min(bucket.utilization, 1.0) : 0;
  const color = bucket ? barColor(pct) : "var(--accent-primary)";
  const fillStyle = bucket?.is_bounded
    ? { height: `${pct * 100}%`, background: color }
    : bucket
      ? { height: "100%", background: "var(--accent-primary)", opacity: 0.4 }
      : { height: "0%", background: "transparent" };

  const readout = bucket
    ? bucket.primary_text
    : t("usage_indicator_no_data", { defaultValue: "—" });
  const tooltip = bucket
    ? `${bucket.label}: ${bucket.primary_text}`
    : (snapshot.note ?? snapshot.source_label);

  return (
    <div className={styles.wrapper}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.indicator} ${bucket?.exhausted ? styles.exhausted : ""}`}
        title={tooltip}
        aria-label={tooltip}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <div className={styles.bar}>
          <div className={styles.barFill} style={fillStyle} />
        </div>
        <span className={styles.readout}>{readout}</span>
      </button>
      {open && (
        <UsagePopover
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          snapshot={snapshot}
          activeBucketKey={bucket?.key}
        />
      )}
    </div>
  );
}
