import { useAppStore } from "../../stores/useAppStore";
import { useTranslation } from "react-i18next";
import type { AgentDetails } from "../../hooks/mergeSubagentTaskRuns";
import styles from "./TaskList.module.css";

type SidebarKey = keyof typeof import("../../locales/en/sidebar.json");

const statusKeys: Record<string, SidebarKey> = {
  starting: "agent_delegated", delegated: "agent_delegated", running: "agent_running",
  needs_approval: "agent_approval", completed: "agent_completed", failed: "agent_failed",
  error: "agent_failed", stopped: "agent_stopped", killed: "agent_stopped",
  disconnected: "agent_disconnected",
};

export function SubagentStatus({ status }: { status: string }) {
  const { t } = useTranslation("sidebar");
  return <span className={styles.agentStatus} data-status={status}>{t(statusKeys[status] ?? "agent_unknown")}</span>;
}

function LinkedSessionButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("sidebar");
  const workspaceId = useAppStore((state) => state.selectedWorkspaceId);
  const visible = useAppStore((state) => workspaceId && state.sessionsByWorkspace[workspaceId]
    ?.some((session) => session.id === sessionId && session.status === "Active"));
  if (!workspaceId || !visible) return null;
  return <button className={styles.linkedSession} type="button" onClick={() => {
    const store = useAppStore.getState();
    store.clearActiveFileTab(workspaceId);
    store.selectSession(workspaceId, sessionId);
  }}>{t("agent_open_tab")}</button>;
}

export function SubagentDetails({ agent }: { agent: AgentDetails }) {
  const { t, i18n } = useTranslation("sidebar");
  const reportLabel = agent.reportKind === "result" ? "agent_report_result"
    : agent.reportKind === "blocked" ? "agent_report_blocked" : "agent_report_milestone";
  const updated = agent.updatedAt ? new Date(agent.updatedAt) : null;
  return (
    <div className={styles.agentDetails}>
      {agent.parentLabel && <span>{t("agent_parent", { name: agent.parentLabel })}</span>}
      {agent.report && <p><strong>{t(reportLabel)}</strong> {agent.report}</p>}
      {agent.summary && <p>{agent.summary}</p>}
      {agent.linkedSessionId && <LinkedSessionButton sessionId={agent.linkedSessionId} />}
      {updated && !Number.isNaN(updated.getTime()) && (
        <time dateTime={agent.updatedAt} title={updated.toLocaleString(i18n.language)}>
          {t("agent_last_seen", { when: updated.toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" }) })}
        </time>
      )}
    </div>
  );
}
