import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Activity } from "lucide-react";
import type { SessionDashboardMetrics } from "./deriveDashboard";
import { Metric, Leaderboard } from "./DashboardTiles";
import { formatDashboardTokens } from "./dashboardFormat";
import styles from "./Dashboard.module.css";

/**
 * Sticky session-level rollup shown at the top of the dashboard-mode
 * transcript. Surfaces session totals (turns, tool / MCP calls, thinking
 * turns, tokens in/out) plus skill and MCP-server leaderboards. Purely
 * presentational — fed `deriveSessionMetrics(...)` output by
 * `DashboardChatView`.
 */
export const SessionDashboardHeader = memo(function SessionDashboardHeader({
  metrics,
  turnCount,
}: {
  metrics: SessionDashboardMetrics;
  turnCount: number;
}) {
  const { t } = useTranslation("chat");
  const hasLeaderboards =
    metrics.topSkills.length > 0 || metrics.topMcps.length > 0;

  return (
    <div className={styles.sessionHeader}>
      <div className={styles.headerTitleRow}>
        <Activity size={13} aria-hidden="true" />
        <span className={styles.headerTitle}>
          {t("dashboard_session_label")}
        </span>
      </div>

      <div className={styles.statGrid}>
        <Metric value={turnCount} label={t("dashboard_turns")} />
        <Metric value={metrics.toolCalls} label={t("dashboard_tool_calls")} />
        <Metric value={metrics.mcpCalls} label={t("dashboard_mcp_calls")} />
        <Metric
          value={metrics.thinkingTurns}
          label={t("dashboard_thinking_turns")}
        />
        <Metric
          value={formatDashboardTokens(metrics.inputTokens) || "0"}
          label={t("dashboard_tokens_in")}
        />
        <Metric
          value={formatDashboardTokens(metrics.outputTokens) || "0"}
          label={t("dashboard_tokens_out")}
        />
      </div>

      {hasLeaderboards && (
        <div className={styles.leaderboardRowWrap}>
          {metrics.topSkills.length > 0 && (
            <Leaderboard
              title={t("dashboard_top_skills")}
              entries={metrics.topSkills}
            />
          )}
          {metrics.topMcps.length > 0 && (
            <Leaderboard
              title={t("dashboard_top_mcps")}
              entries={metrics.topMcps}
            />
          )}
        </div>
      )}
    </div>
  );
});
