import { useEffect, useCallback, useState } from "react";
import { RefreshCw, LogIn, X } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../../../stores/useAppStore";
import {
  getClaudeCodeUsage,
  openUsageSettings,
  claudeAuthLogin,
  cancelClaudeAuthLogin,
} from "../../../services/tauri";
import type { UsageLimit, ExtraUsage } from "../../../types/usage";
import styles from "../Settings.module.css";

type AuthLoginState =
  | { status: "idle" }
  | { status: "running"; manualUrl: string | null; lines: string[] }
  | { status: "success" }
  | { status: "error"; error: string };

type AuthLoginProgress = { stream: "stdout" | "stderr"; line: string };
type AuthLoginComplete = { success: boolean; error: string | null };

const AUTH_URL_PATTERN = /https?:\/\/[^\s]+/;

function isAuthError(error: string): boolean {
  if (error.includes("ENV_AUTH:")) return false;
  return (
    error.includes("Token refresh failed") ||
    error.includes("credentials not found") ||
    error.includes("expired or been revoked")
  );
}

function barColor(pct: number): string {
  if (pct >= 85) return "var(--status-stopped)";
  if (pct >= 60) return "var(--context-meter-warn)";
  return "var(--accent-primary)";
}

function formatResetTime(resetsAt: string | number): string {
  // Handle ISO 8601 strings or unix timestamps (seconds or milliseconds).
  let resetMs: number;
  if (typeof resetsAt === "string") {
    resetMs = new Date(resetsAt).getTime();
  } else {
    // If the number looks like seconds (< year 2100 in seconds), convert.
    resetMs = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  }
  const diffSec = (resetMs - Date.now()) / 1000;
  if (diffSec <= 0) return "resetting now";
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `resets in ${days}d ${remHours}h`;
  }
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTier(tier: string | null): string {
  if (!tier) return "";
  return tier
    .replace("default_claude_", "")
    .replace(/_/g, " ")
    .toUpperCase();
}

function UsageBar({
  title,
  limit,
}: {
  title: string;
  limit: UsageLimit;
}) {
  const pct = Math.min(limit.utilization, 100);
  const color = barColor(pct);

  return (
    <div className={styles.usageCard}>
      <div className={styles.usageCardHeader}>
        <span className={styles.usageCardTitle}>{title}</span>
        <span className={styles.usageCardValue} style={{ color }}>
          {Math.floor(pct)}% used
        </span>
      </div>
      <div className={styles.usageBarTrack}>
        <div
          className={styles.usageBarFill}
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div className={styles.usageReset}>{formatResetTime(limit.resets_at)}</div>
    </div>
  );
}



function ExtraUsageSection({ extra }: { extra: ExtraUsage }) {
  if (!extra.is_enabled) {
    return (
      <>
        <div className={styles.usageExtraHeader}>Extra Usage</div>
        <div className={styles.usageCard}>
          <div className={styles.usageCardHeader}>
            <span className={`${styles.usageCardTitle} ${styles.usageDimColor}`}>
              Not enabled
            </span>
            <button
              className={styles.usageManageLink}
              onClick={() => void openUsageSettings().catch(() => {})}
            >
              Enable
            </button>
          </div>
          <div className={styles.usageReset}>
            Turn on extra usage to keep using Claude when you hit your limit
          </div>
        </div>
      </>
    );
  }

  const hasLimit = extra.monthly_limit !== null && extra.monthly_limit !== undefined;
  const usedDollars = (extra.used_credits ?? 0) / 100;
  const limitDollars = hasLimit ? (extra.monthly_limit as number) / 100 : null;
  const pct = extra.utilization ?? 0;

  return (
    <>
      <div className={`${styles.usageCardHeader} ${styles.usageHeaderPadded}`}>
        <div className={styles.usageExtraHeader}>Extra Usage</div>
        <button
          className={styles.usageManageLink}
          onClick={() => void openUsageSettings().catch(() => {})}
        >
          Manage
        </button>
      </div>
      <div className={styles.usageCard}>
        <div className={styles.usageCardHeader}>
          <span className={styles.usageCardTitle}>Monthly spend</span>
          <span className={styles.usageCardValue} style={{ color: barColor(pct) }}>
            ${usedDollars.toFixed(2)}
            {limitDollars !== null ? ` / $${limitDollars.toFixed(2)}` : " (unlimited)"}
          </span>
        </div>
        {hasLimit && (
          <div className={styles.usageBarTrack}>
            <div
              className={styles.usageBarFill}
              style={{
                width: `${Math.min(pct, 100)}%`,
                background: barColor(pct),
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}

type FetchState =
  | { status: "loading" }
  | { status: "success" }
  | { status: "error"; error: string };

export function UsageSettings() {
  const usage = useAppStore((s) => s.claudeCodeUsage);
  const setUsage = useAppStore((s) => s.setClaudeCodeUsage);
  const [fetchState, setFetchState] = useState<FetchState>({ status: "loading" });
  const [authState, setAuthState] = useState<AuthLoginState>({ status: "idle" });

  const fetchUsage = useCallback(async () => {
    setFetchState({ status: "loading" });
    try {
      const data = await getClaudeCodeUsage();
      setUsage(data);
      setFetchState({ status: "success" });
    } catch (e) {
      setFetchState({ status: "error", error: String(e) });
    }
  }, [setUsage]);

  useEffect(() => {
    // Always fetch on mount — the Rust 5-minute cache prevents API flooding.
    // This ensures reopening settings shows fresh data.
    fetchUsage();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Subscribe to auth-login events once; they only fire while a flow is running.
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    listen<AuthLoginProgress>("auth://login-progress", (event) => {
      const { line } = event.payload;
      const match = line.match(AUTH_URL_PATTERN);
      setAuthState((current) => {
        if (current.status !== "running") return current;
        return {
          status: "running",
          manualUrl: current.manualUrl ?? match?.[0] ?? null,
          lines: [...current.lines, line],
        };
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    listen<AuthLoginComplete>("auth://login-complete", (event) => {
      const { success, error } = event.payload;
      if (success) {
        setAuthState({ status: "success" });
        fetchUsage();
      } else {
        setAuthState({
          status: "error",
          error: error ?? "Sign-in failed.",
        });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [fetchUsage]);

  const startAuthLogin = useCallback(async () => {
    setAuthState({ status: "running", manualUrl: null, lines: [] });
    try {
      await claudeAuthLogin();
    } catch (e) {
      setAuthState({ status: "error", error: String(e) });
    }
  }, []);

  const cancelAuthLogin = useCallback(async () => {
    try {
      await cancelClaudeAuthLogin();
    } catch (e) {
      setAuthState({ status: "error", error: String(e) });
    }
  }, []);

  const limits: { title: string; limit: UsageLimit }[] = [];
  if (usage?.usage.five_hour) {
    limits.push({ title: "Current session", limit: usage.usage.five_hour });
  }
  if (usage?.usage.seven_day) {
    limits.push({ title: "Current week (all models)", limit: usage.usage.seven_day });
  }
  if (usage?.usage.seven_day_sonnet) {
    limits.push({ title: "Current week (Sonnet)", limit: usage.usage.seven_day_sonnet });
  }
  if (usage?.usage.seven_day_opus) {
    limits.push({ title: "Current week (Opus)", limit: usage.usage.seven_day_opus });
  }

  return (
    <div>
      <h2 className={styles.sectionTitle}>Usage</h2>

      {fetchState.status === "loading" && !usage && authState.status !== "running" && (
        <div className={styles.usageEmptyState}>Loading usage data...</div>
      )}

      {authState.status === "running" && (
        <div className={styles.usageEmptyState}>
          <span>Signing in to Claude Code…</span>
          <span className={styles.usageTimestamp}>
            Complete the flow in your browser. This panel will refresh when sign-in finishes.
          </span>
          {authState.manualUrl && (
            <a
              className={styles.usageManageLink}
              href={authState.manualUrl}
              target="_blank"
              rel="noreferrer"
            >
              If the browser didn't open, click here
            </a>
          )}
          <button className={styles.usageRefreshBtn} onClick={cancelAuthLogin}>
            <X size={12} /> Cancel
          </button>
        </div>
      )}

      {fetchState.status === "error" && !usage && authState.status !== "running" && (
        <div className={styles.usageEmptyState}>
          <span className={styles.usageErrorMessage}>
            {fetchState.error.includes("ENV_AUTH:")
              ? fetchState.error.replace("ENV_AUTH:", "")
              : fetchState.error}
          </span>
          {authState.status === "error" && (
            <span className={styles.usageTimestamp}>{authState.error}</span>
          )}
          <div className={styles.usageActions}>
            {isAuthError(fetchState.error) && (
              <button
                className={`${styles.usageRefreshBtn} ${styles.usageRefreshBtnPrimary}`}
                onClick={startAuthLogin}
              >
                <LogIn size={12} /> Sign in
              </button>
            )}
            {!fetchState.error.includes("ENV_AUTH:") && (
              <button className={styles.usageRefreshBtn} onClick={fetchUsage}>
                <RefreshCw size={12} /> Retry
              </button>
            )}
          </div>
        </div>
      )}

      {usage && (
        <div className={styles.usageSection}>
          {(usage.subscription_type || usage.rate_limit_tier) && (
            <div>
              <span className={styles.usagePlanBadge}>
                {usage.subscription_type ?? "Pro"}
                {usage.rate_limit_tier && (
                  <span className={styles.usageMetaDim}>
                    {formatTier(usage.rate_limit_tier)}
                  </span>
                )}
              </span>
            </div>
          )}

          {limits.length === 0 && !usage.usage.extra_usage && (
            <div className={styles.usageEmptyState}>
              No usage data available yet. Usage appears after your first Claude Code interaction.
            </div>
          )}

          {limits.map((l) => (
            <UsageBar key={l.title} title={l.title} limit={l.limit} />
          ))}

          {usage.usage.extra_usage && (
            <ExtraUsageSection extra={usage.usage.extra_usage} />
          )}

          <div className={styles.usageFooter}>
            <span className={styles.usageTimestamp}>
              Last updated {formatTimestamp(usage.fetched_at)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
