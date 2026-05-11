import { memo, useCallback, useMemo, useEffect, useState } from "react";
import { GitBranch, Globe, ChevronDown, ChevronRight, Archive, RotateCcw } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import type { AgentStatus } from "../../types/workspace";
import { isAgentBusy } from "../../utils/agentStatus";
import { RepoIcon } from "../shared/RepoIcon";
import { PanelHeader } from "../shared/PanelHeader";
import { PanelToggles } from "../shared/PanelToggles";
import { StatsStrip, AnalyticsSection, MicroStats } from "../metrics";
import { SessionStatusIcon, type SessionStatusKind } from "../shared/SessionStatusIcon";
import { resolveScmPrIcon } from "../shared/workspaceStatusIcon";
import { formatElapsedSeconds } from "../chat/chatHelpers";
import { WelcomeEmptyState } from "./WelcomeEmptyState";
import { useCreateWorkspace } from "../../hooks/useCreateWorkspace";
import { restoreWorkspace } from "../../services/tauri";
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


const WorkspaceCard = memo(function WorkspaceCard({
  ws,
  repo,
  baseBranch,
  lastMsg,
  remoteName,
  badge,
  onClick,
  index,
}: {
  ws: { id: string; branch_name: string; agent_status: AgentStatus };
  repo: { name: string; icon: string | null } | undefined;
  baseBranch: string | undefined;
  lastMsg: { role: string; content: string } | undefined;
  remoteName: string | undefined;
  badge: "ask" | "plan" | "done" | null;
  onClick: (id: string | null) => void;
  index: number;
}) {
  // Subscribe per-card so a PR/CI poll for one workspace doesn't
  // re-render every other card. Sidebar reads the whole map because it
  // also uses it for grouping; here we only need this row's slice.
  const summary = useAppStore((s) => s.scmSummary[ws.id]);
  const isRunning = isAgentBusy(ws.agent_status);
  const promptStartTime = useAppStore((s) => s.promptStartTime[ws.id] ?? null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || promptStartTime == null) {
      setElapsed(0);
      return;
    }
    setElapsed(Math.floor((Date.now() - promptStartTime) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - promptStartTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, promptStartTime]);

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
        : null,
  ]
    .filter(Boolean)
    .join(" ");

  const statusTitle = isRunning
    ? "Running"
    : typeof ws.agent_status === "string"
      ? ws.agent_status
      : "Error";

  const isStopped =
    ws.agent_status === "Stopped" || typeof ws.agent_status !== "string";

  // PR-state icon takes over once attention badges and running spinner
  // have been ruled out — keeps the Dashboard card in lock-step with the
  // Sidebar row so a merged PR shows GitMerge in both places.
  const showPrIcon = !badge && !isRunning;
  const prIcon = showPrIcon ? resolveScmPrIcon(summary) : null;

  const statusKind: SessionStatusKind =
    badge === "ask"  ? { kind: "ask" } :
    badge === "plan" ? { kind: "plan" } :
    badge === "done" ? { kind: "unread" } :
    isRunning        ? { kind: "running" } :
    isStopped        ? { kind: "stopped" } :
                       { kind: "idle" };

  const statusIconTitle =
    badge === "ask"  ? "Question requires attention" :
    badge === "plan" ? "Plan approval needed" :
    badge === "done" ? "Completed" :
    prIcon           ? prIcon.title :
                       statusTitle;

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
              {formatElapsedSeconds(elapsed)}
            </span>
          )}
          <span title={statusIconTitle} aria-label={statusIconTitle} role="img">
            {prIcon ? (
              <prIcon.Icon size={14} style={{ color: prIcon.color }} />
            ) : (
              <SessionStatusIcon status={statusKind} size={14} />
            )}
          </span>
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
  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);
  const openModal = useAppStore((s) => s.openModal);
  const addToast = useAppStore((s) => s.addToast);
  const selectedRepositoryId = useAppStore((s) => s.selectedRepositoryId);

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

  const sortedWorkspaces = useMemo(() => {
    const rows = activeWorkspaces.map((ws) => {
      const wsSessions = sessionsByWorkspace[ws.id] ?? [];
      const hasQuestion = wsSessions.some((s) => agentQuestions[s.id]);
      const hasPlan = wsSessions.some((s) => planApprovals[s.id]);
      const badge: "ask" | "plan" | "done" | null =
        hasQuestion ? "ask" :
        hasPlan ? "plan" :
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
  }, [activeWorkspaces, agentQuestions, planApprovals, unreadCompletions, lastMessages, sessionsByWorkspace]);

  // Repo IDs ranked by most-recent activity (last message anywhere in any workspace
  // for that repo). Drives which project the welcome screen highlights as the
  // suggested target for the primary CTA.
  const recentRepoIds = useMemo(() => {
    const lastUsedByRepo = new Map<string, string>();
    for (const ws of workspaces) {
      const ts = lastMessages[ws.id]?.created_at ?? ws.created_at;
      const cur = lastUsedByRepo.get(ws.repository_id);
      if (!cur || ts > cur) lastUsedByRepo.set(ws.repository_id, ts);
    }
    return [...lastUsedByRepo.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([repoId]) => repoId);
  }, [workspaces, lastMessages]);

  const localRepositories = useMemo(
    () => repositories.filter((r) => !r.remote_connection_id),
    [repositories],
  );

  const { create: createWorkspaceForRepo, creating } = useCreateWorkspace();

  const handleCreateForRepo = useCallback(
    async (repoId: string) => {
      try {
        await createWorkspaceForRepo(repoId);
      } catch (e) {
        addToast(`Failed to create workspace: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [createWorkspaceForRepo, addToast],
  );

  const handleAddRepository = useCallback(() => {
    openModal("addRepo");
  }, [openModal]);

  // Project-scoped view: a single repo "selected" (via Cmd+N or repo-header
  // click) replaces the global Dashboard with that project's slice.
  const scopedRepo = useMemo(
    () => (selectedRepositoryId ? repoMap.get(selectedRepositoryId) ?? null : null),
    [selectedRepositoryId, repoMap],
  );

  const scopedWorkspaceRows = useMemo(
    () => (scopedRepo
      ? sortedWorkspaces.filter(({ ws }) => ws.repository_id === scopedRepo.id)
      : []),
    [sortedWorkspaces, scopedRepo],
  );

  const scopedArchivedWorkspaces = useMemo(
    () => (scopedRepo
      ? workspaces
          .filter((ws) => ws.repository_id === scopedRepo.id && ws.status === "Archived")
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
      : []),
    [workspaces, scopedRepo],
  );

  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [restoringWsId, setRestoringWsId] = useState<string | null>(null);
  const handleRestoreWorkspace = useCallback(
    async (wsId: string) => {
      if (restoringWsId) return;
      setRestoringWsId(wsId);
      try {
        const path = await restoreWorkspace(wsId);
        updateWorkspace(wsId, { status: "Active", worktree_path: path });
      } catch (e) {
        addToast(`Failed to restore: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setRestoringWsId(null);
      }
    },
    [updateWorkspace, addToast, restoringWsId],
  );

  if (scopedRepo) {
    const scopedRunning = scopedWorkspaceRows.filter(
      ({ ws }) => isAgentBusy(ws.agent_status),
    ).length;
    return (
      <div className={styles.dashboard}>
        <PanelHeader
          left={
            <span className={styles.scopedHeader}>
              {scopedRepo.icon && (
                <RepoIcon icon={scopedRepo.icon} size={12} className={styles.repoIcon} />
              )}
              <span className={styles.scopedRepoName}>{scopedRepo.name}</span>
              <span className={styles.headerPath}>{scopedRepo.path}</span>
            </span>
          }
          right={<PanelToggles />}
        />
        <div className={styles.scrollBody}>
          <WelcomeEmptyState
            repositories={[scopedRepo]}
            recentRepoIds={[scopedRepo.id]}
            onCreateWorkspace={handleCreateForRepo}
            onAddRepository={handleAddRepository}
            creating={creating}
            title={`Start a workspace in ${scopedRepo.name}.`}
            subtitle={
              scopedWorkspaceRows.length > 0
                ? "Or jump back into one of the workspaces below."
                : "This project doesn't have any active workspaces yet."
            }
          />
          {scopedWorkspaceRows.length > 0 && (
            <div className={styles.workspacesSection}>
              <button
                type="button"
                className={styles.workspacesHeader}
                onClick={() => setWorkspacesOpen((v) => !v)}
                aria-expanded={workspacesOpen}
              >
                {workspacesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className={styles.workspacesTitle}>Workspaces</span>
                {scopedRunning > 0 && (
                  <span className={styles.headerCount}>
                    {scopedRunning} running
                  </span>
                )}
              </button>
              {workspacesOpen && (
                <div className={styles.grid}>
                  {scopedWorkspaceRows.map(({ ws, badge }, i) => (
                    <WorkspaceCard
                      key={ws.id}
                      ws={ws}
                      repo={scopedRepo}
                      baseBranch={defaultBranches[scopedRepo.id]}
                      lastMsg={lastMessages[ws.id]}
                      remoteName={ws.remote_connection_id ? remoteNameMap.get(ws.remote_connection_id) : undefined}
                      badge={badge}
                      onClick={selectWorkspace}
                      index={i}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {scopedArchivedWorkspaces.length > 0 && (
            <div className={styles.workspacesSection}>
              <button
                type="button"
                className={styles.workspacesHeader}
                onClick={() => setArchivedOpen((v) => !v)}
                aria-expanded={archivedOpen}
              >
                {archivedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Archive size={12} className={styles.archivedIcon} aria-hidden="true" />
                <span className={styles.workspacesTitle}>Archived</span>
                <span className={styles.headerCount}>
                  {scopedArchivedWorkspaces.length}
                </span>
              </button>
              {archivedOpen && (
                <ul className={styles.archivedList}>
                  {scopedArchivedWorkspaces.map((ws) => (
                    <li key={ws.id} className={styles.archivedRow}>
                      <span className={styles.archivedBody}>
                        <span className={styles.archivedName}>{ws.name}</span>
                        <span className={styles.archivedBranch}>
                          <GitBranch size={11} aria-hidden="true" />
                          {ws.branch_name}
                        </span>
                      </span>
                      <button
                        type="button"
                        className={styles.archivedRestore}
                        onClick={() => handleRestoreWorkspace(ws.id)}
                        disabled={restoringWsId !== null}
                        title={`Restore ${ws.name}`}
                        aria-label={`Restore ${ws.name}`}
                      >
                        <RotateCcw size={12} />
                        Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (activeWorkspaces.length === 0) {
    return (
      <div className={styles.dashboard}>
        <PanelHeader
          left={<span className={styles.dashboardTitle}>Dashboard</span>}
          right={<PanelToggles />}
        />
        <div className={styles.scrollBody}>
          <StatsStrip />
          <AnalyticsSection />
          <WelcomeEmptyState
            repositories={localRepositories}
            recentRepoIds={recentRepoIds}
            onCreateWorkspace={handleCreateForRepo}
            onAddRepository={handleAddRepository}
            creating={creating}
          />
        </div>
      </div>
    );
  }

  const runningCount = activeWorkspaces.filter(
    (ws) => isAgentBusy(ws.agent_status)
  ).length;

  return (
    <div className={styles.dashboard}>
      <PanelHeader
        left={<span className={styles.dashboardTitle}>Dashboard</span>}
        right={<PanelToggles />}
      />
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
