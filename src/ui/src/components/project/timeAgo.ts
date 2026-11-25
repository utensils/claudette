import i18n from "../../i18n";
/// Format an ISO-8601 timestamp into a compact relative string used by
/// the project-view rows. Intentionally short ("2d", "3w") to keep the
/// row right-edge tight; precision drops off for older items because the
/// list is sorted by `updated_at DESC` and the head is what users care
/// about.
export function formatTimeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const seconds = Math.max(0, (Date.now() - t) / 1000);
  if (seconds < 60) return i18n.t("time_ago_now");
  const minutes = seconds / 60;
  if (minutes < 60) return i18n.t("time_ago_minutes", { n: Math.round(minutes) });
  const hours = minutes / 60;
  if (hours < 24) return i18n.t("time_ago_hours", { n: Math.round(hours) });
  const days = hours / 24;
  if (days < 7) return i18n.t("time_ago_days", { n: Math.round(days) });
  const weeks = days / 7;
  if (weeks < 5) return i18n.t("time_ago_weeks", { n: Math.round(weeks) });
  const months = days / 30;
  if (months < 12) return i18n.t("time_ago_months", { n: Math.round(months) });
  return i18n.t("time_ago_years", { n: Math.round(days / 365) });
}
