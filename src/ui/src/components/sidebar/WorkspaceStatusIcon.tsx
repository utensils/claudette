import { useTranslation } from "react-i18next";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleStop,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { isAgentBusy } from "../../utils/agentStatus";
import type { Workspace } from "../../types/workspace";
import { WorkspaceEnvSpinner } from "./WorkspaceEnvSpinner";
import styles from "./Sidebar.module.css";

interface Props {
  workspace: Workspace;
}

/// The leading status badge / icon for a workspace row in the sidebar.
///
/// Resolves the state to display by combining four orthogonal signals:
///   - per-session attention (agent question, plan approval) — highest priority
///   - per-workspace attention (unread completion since last view)
///   - agent runtime state (Running / Compacting / Stopped / Idle)
///   - workspace lifecycle (Archived) and SCM state (PR + CI)
///
/// All inputs are read from the store inside this component so callers don't
/// have to thread props through; remote and local workspaces use the same
/// component because every input above is workspace-scoped, not connection-scoped.
export function WorkspaceStatusIcon({ workspace: ws }: Props) {
  const { t } = useTranslation("sidebar");
  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);
  const agentQuestions = useAppStore((s) => s.agentQuestions);
  const planApprovals = useAppStore((s) => s.planApprovals);
  const unreadCompletions = useAppStore((s) => s.unreadCompletions);
  const scmSummary = useAppStore((s) => s.scmSummary);
  const workspaceEnvironment = useAppStore((s) => s.workspaceEnvironment);

  const wsSessions = sessionsByWorkspace[ws.id] ?? [];
  const hasQuestion = wsSessions.some(
    (s) => agentQuestions[s.id] || (s.needs_attention && s.attention_kind !== "Plan"),
  );
  const hasPlan = wsSessions.some(
    (s) => planApprovals[s.id] || (s.needs_attention && s.attention_kind === "Plan"),
  );
  const badge: "ask" | "plan" | "done" | null =
    hasQuestion ? "ask"
      : hasPlan ? "plan"
        : unreadCompletions.has(ws.id) && !isAgentBusy(ws.agent_status) ? "done"
          : null;

  if (badge === "done") {
    return (
      <span
        className={styles.badgeDone}
        title={t("status_badge_completed_title")}
        aria-label={t("status_badge_completed_aria")}
        role="img"
      >
        <CircleCheck size={14} />
      </span>
    );
  }
  if (badge === "plan") {
    return (
      <span
        className={styles.badgePlan}
        title={t("status_badge_plan_title")}
        aria-label={t("status_badge_plan_aria")}
        role="img"
      >
        <CircleAlert size={14} />
      </span>
    );
  }
  if (badge === "ask") {
    return (
      <span
        className={styles.badgeAsk}
        title={t("status_badge_ask_title")}
        aria-label={t("status_badge_ask_aria")}
        role="img"
      >
        <CircleQuestionMark size={14} />
      </span>
    );
  }
  if (
    workspaceEnvironment[ws.id]?.status === "preparing"
    && ws.agent_status !== "Running"
    && ws.agent_status !== "Compacting"
  ) {
    return <WorkspaceEnvSpinner workspaceId={ws.id} />;
  }
  if (ws.agent_status === "Running" || ws.agent_status === "Compacting") {
    return (
      <span
        className={styles.statusSpinner}
        aria-hidden="true"
        title={ws.agent_status === "Compacting" ? t("status_compacting") : t("status_running")}
      >
        <span className={styles.statusSpinnerRing} />
      </span>
    );
  }
  if (ws.status === "Archived") {
    return (
      <span className={styles.statusIcon} title={t("status_archived_title")}>
        <Archive size={14} style={{ color: "var(--text-dim)" }} />
      </span>
    );
  }

  const summary = scmSummary[ws.id];
  if (summary?.hasPr) {
    const prState = summary.prState;
    const ciState = summary.ciState;
    const Icon = prState === "merged" ? GitMerge
      : prState === "closed" ? GitPullRequestClosed
        : prState === "draft" ? GitPullRequestDraft
          : GitPullRequestArrow;
    const color = prState === "merged" ? "var(--badge-plan)"
      : prState === "closed" ? "var(--status-stopped)"
        : prState === "draft" ? "var(--text-dim)"
          : ciState === "failure" ? "var(--status-stopped)"
            : ciState === "pending" ? "var(--badge-ask)"
              : "var(--badge-done)";
    const titleText = `PR: ${prState}${ciState ? `, CI: ${ciState}` : ""}`;
    return (
      <span className={styles.statusIcon} title={titleText}>
        <Icon size={14} style={{ color }} />
      </span>
    );
  }

  if (ws.agent_status === "Stopped") {
    return (
      <span className={styles.statusIcon} title={t("status_stopped")}>
        <CircleStop size={14} style={{ color: "var(--status-stopped)" }} />
      </span>
    );
  }
  return (
    <span className={styles.statusIcon} title={t("status_idle")}>
      <CircleDashed size={14} style={{ color: "var(--text-dim)" }} />
    </span>
  );
}
