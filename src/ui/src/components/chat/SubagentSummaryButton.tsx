import { ChevronRight, GitFork } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTaskTrackerWithHistory } from "../../hooks/useTaskTracker";
import { useAppStore } from "../../stores/useAppStore";
import styles from "./SubagentSummaryButton.module.css";

export function SubagentSummaryButton({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }) {
  const { t } = useTranslation("sidebar");
  const { subagents, history } = useTaskTrackerWithHistory(sessionId);
  const count = subagents.length + history.filter((run) => run.agent).length;
  if (!count) return null;
  const awaiting = subagents.filter((run) => run.status === "needs_approval").length;
  const open = () => {
    const store = useAppStore.getState();
    store.setRightSidebarTabForWorkspace(workspaceId, "tasks");
    if (!store.rightSidebarVisible) store.toggleRightSidebar();
  };
  return (
    <button type="button" className={styles.summary} onClick={open} title={t("agent_view_tasks")}>
      <GitFork size={14} aria-hidden="true" />
      <span>{t("agent_count", { count })}</span>
      {awaiting > 0 && <span className={styles.attention}>{t("agent_approval_count", { count: awaiting })}</span>}
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );
}
