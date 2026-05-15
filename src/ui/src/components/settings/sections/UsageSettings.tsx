import { useEffect, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import {
  getClaudeCodeUsage,
  openUsageSettings,
} from "../../../services/tauri";
import type { UsageLimit, ExtraUsage } from "../../../types/usage";
import { formatResetIn } from "../../../utils/usageReset";
import {
  cleanClaudeAuthError,
  isClaudeAuthError,
} from "../../auth/claudeAuth";
import { ClaudeCodeAuthPanel } from "../../auth/ClaudeCodeAuthPanel";
import styles from "../Settings.module.css";

function barColor(pct: number): string {
  if (pct >= 85) return "var(--status-stopped)";
  if (pct >= 60) return "var(--context-meter-warn)";
  return "var(--accent-primary)";
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
  const { t } = useTranslation("settings");
  const pct = Math.min(limit.utilization, 100);
  const color = barColor(pct);

  return (
    <div className={styles.usageCard}>
      <div className={styles.usageCardHeader}>
        <span className={styles.usageCardTitle}>{title}</span>
        <span className={styles.usageCardValue} style={{ color }}>
          {t("usage_pct_used", { pct: Math.floor(pct) })}
        </span>
      </div>
      <div className={styles.usageBarTrack}>
        <div
          className={styles.usageBarFill}
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div className={styles.usageReset}>{formatResetIn(limit.resets_at)}</div>
    </div>
  );
}

function ExtraUsageSection({ extra }: { extra: ExtraUsage }) {
  const { t } = useTranslation("settings");

  if (!extra.is_enabled) {
    return (
      <>
        <div className={styles.usageExtraHeader}>{t("usage_extra_title")}</div>
        <div className={styles.usageCard}>
          <div className={styles.usageCardHeader}>
            <span className={`${styles.usageCardTitle} ${styles.usageDimColor}`}>
              {t("usage_extra_not_enabled")}
            </span>
            <button
              className={styles.usageManageLink}
              onClick={() => void openUsageSettings().catch(() => {})}
            >
              {t("usage_extra_enable")}
            </button>
          </div>
          <div className={styles.usageReset}>
            {t("usage_extra_not_enabled_hint")}
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
        <div className={styles.usageExtraHeader}>{t("usage_extra_title")}</div>
        <button
          className={styles.usageManageLink}
          onClick={() => void openUsageSettings().catch(() => {})}
        >
          {t("usage_extra_manage")}
        </button>
      </div>
      <div className={styles.usageCard}>
        <div className={styles.usageCardHeader}>
          <span className={styles.usageCardTitle}>{t("usage_monthly_spend")}</span>
          <span className={styles.usageCardValue} style={{ color: barColor(pct) }}>
            ${usedDollars.toFixed(2)}
            {limitDollars !== null ? ` / $${limitDollars.toFixed(2)}` : t("usage_unlimited")}
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
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const usage = useAppStore((s) => s.claudeCodeUsage);
  const setUsage = useAppStore((s) => s.setClaudeCodeUsage);
  const [fetchState, setFetchState] = useState<FetchState>({ status: "loading" });

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
    fetchUsage();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const limits: { title: string; limit: UsageLimit }[] = [];
  if (usage?.usage.five_hour) {
    limits.push({ title: t("usage_limit_session"), limit: usage.usage.five_hour });
  }
  if (usage?.usage.seven_day) {
    limits.push({ title: t("usage_limit_week_all"), limit: usage.usage.seven_day });
  }
  if (usage?.usage.seven_day_sonnet) {
    limits.push({ title: t("usage_limit_week_sonnet"), limit: usage.usage.seven_day_sonnet });
  }
  if (usage?.usage.seven_day_opus) {
    limits.push({ title: t("usage_limit_week_opus"), limit: usage.usage.seven_day_opus });
  }

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("usage_title")}</h2>

      {fetchState.status === "loading" && !usage && (
        <div className={styles.usageEmptyState}>{t("usage_loading")}</div>
      )}

      {fetchState.status === "error" && !usage && (
        isClaudeAuthError(fetchState.error) ? (
          <ClaudeCodeAuthPanel
            error={fetchState.error}
            onAuthenticated={fetchUsage}
            onRetry={fetchUsage}
          />
        ) : (
          <div className={styles.usageEmptyState}>
            <span className={styles.usageErrorMessage}>
              {cleanClaudeAuthError(fetchState.error)}
            </span>
            {!fetchState.error.includes("ENV_AUTH:") && (
              <button className={styles.usageRefreshBtn} onClick={fetchUsage}>
                <RefreshCw size={12} /> {tCommon("retry")}
              </button>
            )}
          </div>
        )
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
              {t("usage_no_data")}
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
              {t("usage_last_updated", { time: formatTimestamp(usage.fetched_at) })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
