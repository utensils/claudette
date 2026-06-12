import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  ActivityCategory,
  SkillTally,
  TurnDashboardMetrics,
} from "./deriveDashboard";
import styles from "./Dashboard.module.css";

/** A single metric chip: a mono value beside a dim label. */
export const Metric = memo(function Metric({
  value,
  label,
}: {
  value: string | number;
  label: string;
}) {
  return (
    <span className={styles.metric}>
      <span className={styles.metricValue}>{value}</span>
      <span className={styles.metricLabel}>{label}</span>
    </span>
  );
});

/** The tool-call categories worth breaking out, in display order.
 *  `question` and `plan` are surfaced as their own top-level metrics, and
 *  `other` is noise — so they're omitted here. */
const BREAKDOWN_ORDER: ActivityCategory[] = [
  "file",
  "edit",
  "bash",
  "mcp",
  "skill",
  "subagent",
];

/** Localized noun for a category. A literal-key switch (rather than a keyed
 *  map) so each `t(...)` call type-checks against the typed translation keys
 *  without tripping the deep-instantiation limit. */
function categoryLabel(t: TFunction<"chat">, c: ActivityCategory): string {
  switch (c) {
    case "file":
      return t("dashboard_cat_file");
    case "edit":
      return t("dashboard_cat_edit");
    case "bash":
      return t("dashboard_cat_bash");
    case "mcp":
      return t("dashboard_cat_mcp");
    case "skill":
      return t("dashboard_cat_skill");
    case "subagent":
      return t("dashboard_cat_subagent");
    default:
      return t("dashboard_cat_other");
  }
}

/**
 * A small ranked-bar leaderboard widget (e.g. "Top skills", "Top MCPs").
 * Each row is name · proportional bar · count, scaled to the top entry.
 * Renders a muted placeholder when there's nothing to rank.
 */
export const Leaderboard = memo(function Leaderboard({
  title,
  entries,
}: {
  title: string;
  entries: SkillTally[];
}) {
  const max = entries.length > 0 ? entries[0].count : 0;
  return (
    <div className={styles.leaderboard}>
      <div className={styles.leaderboardTitle}>{title}</div>
      {entries.length === 0 ? (
        <div className={styles.leaderboardEmpty}>—</div>
      ) : (
        entries.map((entry) => (
          <div key={entry.name} className={styles.leaderboardRow}>
            <span className={styles.leaderboardName} title={entry.name}>
              {entry.name}
            </span>
            <span className={styles.leaderboardBarTrack} aria-hidden="true">
              <span
                className={styles.leaderboardBar}
                style={{ width: `${max > 0 ? (entry.count / max) * 100 : 0}%` }}
              />
            </span>
            <span className={styles.leaderboardCount}>{entry.count}</span>
          </div>
        ))
      )}
    </div>
  );
});

/** A one-line per-category breakdown of a turn's tool calls (e.g.
 *  `4 reads · 2 edits · 1 shell`). Renders nothing when no listed category
 *  fired. */
export const CategoryBreakdown = memo(function CategoryBreakdown({
  byCategory,
}: {
  byCategory: TurnDashboardMetrics["byCategory"];
}) {
  const { t } = useTranslation("chat");
  const present = BREAKDOWN_ORDER.filter((c) => byCategory[c] > 0);
  if (present.length === 0) return null;
  return (
    <div className={styles.categoryBreakdown}>
      {present.map((c) => (
        <span key={c} className={styles.categoryChip}>
          <span className={styles.categoryChipValue}>{byCategory[c]}</span>{" "}
          {categoryLabel(t, c)}
        </span>
      ))}
    </div>
  );
});
