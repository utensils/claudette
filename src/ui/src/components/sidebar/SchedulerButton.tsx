import { Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { liveSessionId, summarize, taskStatus } from "../scheduler/schedulerModel";
import sidebarStyles from "./Sidebar.module.css";
import styles from "./SchedulerButton.module.css";

/** Sidebar-header toggle for the Loops and Schedules view, badged with how
 *  many loops are armed — tinted when one needs attention, pulsing while a
 *  scheduled run is in progress. */
export function SchedulerButton() {
  const { t } = useTranslation("sidebar");
  const schedulerOpen = useAppStore((s) => s.schedulerOpen);
  const openScheduler = useAppStore((s) => s.openScheduler);
  const closeScheduler = useAppStore((s) => s.closeScheduler);
  const tasks = useAppStore((s) => s.scheduledTasks);
  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);

  const summary = summarize(tasks, (task) => {
    const sid = liveSessionId(task);
    const running =
      !!sid &&
      sessionsByWorkspace[task.workspace_id]?.find((s) => s.id === sid)?.agent_status ===
        "Running";
    return taskStatus(task, running);
  });
  const armed = summary.looping + summary.scheduled;
  const label =
    armed > 0 || summary.attention > 0
      ? `${t("scheduler")} — ${t("scheduler_status", {
          looping: summary.looping,
          scheduled: summary.scheduled,
          attention: summary.attention,
        })}`
      : t("scheduler");

  const badgeClass = [
    styles.badge,
    summary.attention > 0 ? styles.badgeAttention : "",
    summary.running > 0 ? styles.badgeRunning : "",
  ].join(" ");

  return (
    <button
      className={`${schedulerOpen ? sidebarStyles.dashboardBtnActive : sidebarStyles.dashboardBtn} ${styles.button}`}
      onClick={() => (schedulerOpen ? closeScheduler() : openScheduler())}
      title={label}
      aria-label={label}
      aria-pressed={schedulerOpen}
    >
      <Clock size={12} />
      {(armed > 0 || summary.attention > 0) && (
        <span className={badgeClass}>{summary.attention > 0 ? "!" : armed}</span>
      )}
    </button>
  );
}
