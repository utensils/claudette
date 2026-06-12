import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolActivity } from "../../../stores/useAppStore";
import type { ToolDisplayMode } from "../../../stores/slices/settingsSlice";
import type { TurnDashboardMetrics } from "./deriveDashboard";
import { Metric, CategoryBreakdown } from "./DashboardTiles";
import {
  formatDashboardDuration,
  formatDashboardTokens,
} from "./dashboardFormat";
import { ThinkingBlock } from "../ThinkingBlock";
import { ToolActivitiesSection } from "../ToolActivitiesSection";
import styles from "./Dashboard.module.css";

/**
 * Per-turn activity card for dashboard mode. Replaces the streamed tool
 * calls / thinking / intermediate narration of a single turn with a compact
 * metric summary, and expands on demand to the canonical detail renderers
 * (`ThinkingBlock` + `ToolActivitiesSection`) — so "reveal detail" shows the
 * real activity, not a re-creation of it.
 */
export const TurnDashboardCard = memo(function TurnDashboardCard({
  metrics,
  sessionId,
  toolDisplayMode,
  searchQuery,
  worktreePath,
  activities,
  thinkingContents,
}: {
  metrics: TurnDashboardMetrics;
  sessionId: string;
  toolDisplayMode: ToolDisplayMode;
  searchQuery: string;
  worktreePath?: string | null;
  /** The turn's tool activities — `CompletedTurn.activities` for a finished
   *  turn, or the live `toolActivities[sessionId]` for the in-flight one. */
  activities: ToolActivity[];
  /** Thinking blocks captured for this turn (assistant `thinking` + subagent
   *  blocks), rendered when the card is expanded. */
  thinkingContents: string[];
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);

  const isLive = metrics.isLive;
  const duration = formatDashboardDuration(metrics.durationMs);
  const tokens = formatDashboardTokens(
    (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0),
  );
  const hasDetail = activities.length > 0 || thinkingContents.length > 0;

  return (
    <div
      className={`${styles.turnCard} ${isLive ? styles.turnCardLive : ""}`}
      aria-live={isLive ? "polite" : undefined}
    >
      <div className={styles.turnCardHeader}>
        {isLive && <span className={styles.liveDot} aria-hidden="true" />}
        <span className={styles.turnCardTitle}>
          {isLive ? t("dashboard_working") : t("dashboard_turn_label")}
        </span>
      </div>

      <div className={styles.metricRow}>
        <Metric value={metrics.thoughts} label={t("dashboard_thoughts")} />
        <Metric value={metrics.toolCalls} label={t("dashboard_tool_calls")} />
        {metrics.questions > 0 && (
          <Metric value={metrics.questions} label={t("dashboard_questions")} />
        )}
        {metrics.plans > 0 && (
          <Metric value={metrics.plans} label={t("dashboard_plans")} />
        )}
        {metrics.tasks.total > 0 && (
          <Metric
            value={`${metrics.tasks.completed}/${metrics.tasks.total}`}
            label={t("dashboard_tasks")}
          />
        )}
        {duration && (
          <Metric value={duration} label={t("dashboard_duration")} />
        )}
        {tokens && <Metric value={tokens} label={t("dashboard_tokens")} />}
      </div>

      <CategoryBreakdown byCategory={metrics.byCategory} />

      {hasDetail && (
        <button
          type="button"
          className={styles.expandButton}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className={styles.expandChevron}>{expanded ? "⌄" : "›"}</span>
          {expanded ? t("dashboard_hide_detail") : t("dashboard_show_detail")}
        </button>
      )}

      {expanded && (
        <div className={styles.detail}>
          {thinkingContents.map((content, i) => (
            <ThinkingBlock
              key={i}
              content={content}
              isStreaming={false}
              inline
              searchQuery={searchQuery}
            />
          ))}
          {activities.length > 0 ? (
            <ToolActivitiesSection
              sessionId={sessionId}
              toolDisplayMode={toolDisplayMode}
              searchQuery={searchQuery}
              worktreePath={worktreePath}
              activities={activities}
            />
          ) : thinkingContents.length === 0 ? (
            <div className={styles.detailEmpty}>{t("dashboard_no_detail")}</div>
          ) : null}
        </div>
      )}
    </div>
  );
});
