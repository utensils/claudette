import { memo, useMemo, useEffect, useState } from "react";
import { GitBranch, Layers, Globe, BadgeCheck, BadgeInfo, BadgeQuestionMark, ChevronDown, ChevronRight } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import type { AgentStatus } from "../../types/workspace";
import { isAgentBusy } from "../../utils/agentStatus";
import { useSpinnerFrame } from "../../hooks/useSpinnerFrame";
import { RepoIcon } from "../shared/RepoIcon";
import { PanelToggles } from "../shared/PanelToggles";
import { StatsStrip, AnalyticsSection, MicroStats } from "../metrics";
import styles from "./Dashboard.module.css";

/** Strip markdown syntax for a clean one-line preview. */
function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function useElapsed(isRunning: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRunning) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  return elapsed;
}

const WorkspaceCard = memo(function WorkspaceCard({
  ws,
  repo,
  baseBranch,
  lastMsg,
  remoteName,
  badge,
  spinnerChar,
  onClick,
  index,
}: {
  ws: { id: string; branch_name: string; agent_status: AgentStatus };
  repo: { name: string; icon: string | null } | undefined;
  baseBranch: string | undefined;
  lastMsg: { role: string; content: string } | undefined;
  remoteName: string | undefined;
  badge: "ask" | "plan" | "done" | null;
  spinnerChar: string;
  onClick: (id: string | null) => void;
  index: number;
}) {
  const isRunning = isAgentBusy(ws.agent_status);
  const elapsed = useElapsed(isRunning);

  const statusColor =
    isRunning
      ? "var(--status-running)"
      : ws.agent_status === "Stopped" || typeof ws.agent_status !== "string"
        ? "var(--status-stopped)"
        : "var(--status-idle)";

  const cardClass = [
    styles.card,
    isRunning
      ? styles.cardRunning
      : ws.agent_status === "Stopped" || typeof ws.agent_status !== "string"
        ? styles.cardStopped
        : styles.cardIdle,
  ].join(" ");

  const statusTitle = isRunning
    ? "Running"
    : typeof ws.agent_status === "string"
      ? ws.agent_status
      : "Error";

  return (
    <button
      type="button"
      className={cardClass}
      onClick={() => onClick(ws.id)}
      style={{ animationDelay: `${index * 0.04}s` }}
    >
      <div className={styles.cardHeader}>
        <span className={styles.repoName}>
          {repo?.icon && (
            <RepoIcon icon={repo.icon} size={14} className={styles.repoIcon} />
          )}
          {repo?.name ?? "Unknown"}
          {remoteName && (
            <span className={styles.remoteBadge}>
              <Globe size={10} />
              {remoteName}
            </span>
          )}
        </span>
        <span className={styles.statusIndicator}>
          {isRunning && (
            <span className={styles.statusLabel} style={{ color: statusColor }}>
              {formatElapsed(elapsed)}
            </span>
          )}
          {badge === "done" ? (
            <span className={styles.badgeDone} title="Completed" aria-label="Completed" role="img">
              <BadgeCheck size={12} />
            </span>
          ) : badge === "plan" ? (
            <span className={styles.badgePlan} title="Plan approval needed" aria-label="Plan approval needed" role="img">
              <BadgeInfo size={12} />
            </span>
          ) : badge === "ask" ? (
            <span className={styles.badgeAsk} title="Question requires attention" aria-label="Question requires attention" role="img">
              <BadgeQuestionMark size={12} />
            </span>
          ) : isRunning ? (
            <span className={styles.statusSpinner} title={statusTitle} aria-label={statusTitle} role="img">
              {spinnerChar}
            </span>
          ) : (
            <span
              className={styles.statusDot}
              style={{ background: statusColor }}
              title={statusTitle}
              aria-label={statusTitle}
              role="img"
            />
          )}
        </span>
      </div>
      <div className={styles.branchLine}>
        <GitBranch size={12} />
        <span className={styles.branch}>{ws.branch_name}</span>
        {baseBranch && (
          <>
            <span className={styles.arrow}>{">"}</span>
            <span className={styles.baseBranch}>{baseBranch.replace(/^origin\//, '')}</span>
          </>
        )}
      </div>
      {lastMsg ? (
        <div className={styles.lastMessage}>
          <span className={styles.msgRole}>
            {lastMsg.role === "User"
              ? "You"
              : lastMsg.role === "Assistant"
                ? "Claude"
                : "System"}
            :
          </span>{" "}
          <span className={styles.msgContent}>
            {stripMarkdown(lastMsg.content).slice(0, 120)}
            {lastMsg.content.length > 120 ? "..." : ""}
          </span>
        </div>
      ) : (
        <div className={styles.noMessages}>No messages yet</div>
      )}
      <MicroStats workspaceId={ws.id} />
    </button>
  );
});

export function Dashboard() {
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const lastMessages = useAppStore((s) => s.lastMessages);
  const defaultBranches = useAppStore((s) => s.defaultBranches);
  const remoteConnections = useAppStore((s) => s.remoteConnections);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const agentQuestions = useAppStore((s) => s.agentQuestions);
  const planApprovals = useAppStore((s) => s.planApprovals);
  const unreadCompletions = useAppStore((s) => s.unreadCompletions);

  const fetchDashboardMetrics = useAppStore((s) => s.fetchDashboardMetrics);
  const fetchAnalyticsMetrics = useAppStore((s) => s.fetchAnalyticsMetrics);
  const fetchWorkspaceMetricsBatch = useAppStore(
    (s) => s.fetchWorkspaceMetricsBatch
  );

  const [workspacesOpen, setWorkspacesOpen] = useState(true);

  const repoMap = useMemo(
    () => new Map(repositories.map((r) => [r.id, r])),
    [repositories]
  );

  const remoteNameMap = useMemo(
    () => new Map(remoteConnections.map((c) => [c.id, c.name])),
    [remoteConnections]
  );

  const activeWorkspaces = useMemo(
    () => workspaces.filter((ws) => ws.status === "Active"),
    [workspaces],
  );

  useEffect(() => {
    fetchDashboardMetrics();
    fetchAnalyticsMetrics();
    const interval = setInterval(() => {
      fetchDashboardMetrics();
      fetchAnalyticsMetrics();
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchDashboardMetrics, fetchAnalyticsMetrics]);

  const workspaceIdsKey = useMemo(
    () =>
      activeWorkspaces
        .map((ws) => ws.id)
        .sort()
        .join(","),
    [activeWorkspaces]
  );

  useEffect(() => {
    const ids = workspaceIdsKey ? workspaceIdsKey.split(",") : [];
    fetchWorkspaceMetricsBatch(ids);
    const interval = setInterval(() => {
      fetchWorkspaceMetricsBatch(ids);
    }, 30_000);
    return () => clearInterval(interval);
  }, [workspaceIdsKey, fetchWorkspaceMetricsBatch]);

  const anyRunning = useMemo(
    () => activeWorkspaces.some((ws) => isAgentBusy(ws.agent_status)),
    [activeWorkspaces],
  );
  const spinnerChar = useSpinnerFrame(anyRunning);

  const sortedWorkspaces = useMemo(() => {
    const rows = activeWorkspaces.map((ws) => {
      const badge: "ask" | "plan" | "done" | null =
        agentQuestions[ws.id] ? "ask" :
        planApprovals[ws.id] ? "plan" :
        unreadCompletions.has(ws.id) && !isAgentBusy(ws.agent_status) ? "done" :
        null;
      const groupKey = badge ? 0 : isAgentBusy(ws.agent_status) ? 1 : 2;
      const lastUsed = lastMessages[ws.id]?.created_at ?? ws.created_at;
      return { ws, badge, groupKey, lastUsed };
    });
    rows.sort((a, b) => {
      if (a.groupKey !== b.groupKey) return a.groupKey - b.groupKey;
      return b.lastUsed.localeCompare(a.lastUsed);
    });
    return rows;
  }, [activeWorkspaces, agentQuestions, planApprovals, unreadCompletions, lastMessages]);

  if (activeWorkspaces.length === 0) {
    return (
      <div className={styles.dashboard}>
        <div className={styles.toolbar} data-tauri-drag-region>
          <div className={styles.header}>Dashboard</div>
          <PanelToggles />
        </div>
        <div className={styles.scrollBody}>
          <StatsStrip />
          <AnalyticsSection />
          <div className={styles.empty}>
            <Layers size={40} className={styles.emptyIcon} />
            <span className={styles.emptyTitle}>No active workspaces</span>
            <p className={styles.hint}>
              Create a workspace from a repository in the sidebar, or press{" "}
              <kbd className={styles.hintKey}>+</kbd> next to a repo name.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const runningCount = activeWorkspaces.filter(
    (ws) => isAgentBusy(ws.agent_status)
  ).length;

  return (
    <div className={styles.dashboard}>
      <div className={styles.toolbar} data-tauri-drag-region>
        <div className={styles.header}>Dashboard</div>
        <PanelToggles />
      </div>
      <div className={styles.scrollBody}>
        <StatsStrip />
        <AnalyticsSection />
        <div className={styles.workspacesSection}>
          <button
            type="button"
            className={styles.workspacesHeader}
            onClick={() => setWorkspacesOpen((v) => !v)}
            aria-expanded={workspacesOpen}
          >
            {workspacesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className={styles.workspacesTitle}>Active Workspaces</span>
            {runningCount > 0 && (
              <span className={styles.headerCount}>
                {runningCount} running
              </span>
            )}
          </button>
          {workspacesOpen && (
            <div className={styles.grid}>
              {sortedWorkspaces.map(({ ws, badge }, i) => {
                const repo = repoMap.get(ws.repository_id);
                return (
                  <WorkspaceCard
                    key={ws.id}
                    ws={ws}
                    repo={repo}
                    baseBranch={repo ? defaultBranches[repo.id] : undefined}
                    lastMsg={lastMessages[ws.id]}
                    remoteName={ws.remote_connection_id ? remoteNameMap.get(ws.remote_connection_id) : undefined}
                    badge={badge}
                    spinnerChar={isAgentBusy(ws.agent_status) ? spinnerChar : ""}
                    onClick={selectWorkspace}
                    index={i}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
