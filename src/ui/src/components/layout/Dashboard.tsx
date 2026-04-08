import { memo, useMemo, useEffect, useState } from "react";
import { GitBranch, Layers, Globe } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { RepoIcon } from "../shared/RepoIcon";
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
  onClick,
  index,
}: {
  ws: { id: string; branch_name: string; agent_status: string | { Error: string } };
  repo: { name: string; icon: string | null } | undefined;
  baseBranch: string | undefined;
  lastMsg: { role: string; content: string } | undefined;
  remoteName: string | undefined;
  onClick: (id: string | null) => void;
  index: number;
}) {
  const isRunning = ws.agent_status === "Running";
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

  const statusText = isRunning
    ? formatElapsed(elapsed)
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
          <span className={styles.statusLabel} style={{ color: statusColor }}>
            {statusText}
          </span>
          <span
            className={`${styles.statusDot} ${isRunning ? styles.statusDotRunning : ""}`}
            style={{ background: statusColor }}
          />
        </span>
      </div>
      <div className={styles.branchLine}>
        <GitBranch size={11} />
        <span className={styles.branch}>{ws.branch_name}</span>
        {baseBranch && (
          <>
            <span className={styles.arrow}>{">"}</span>
            <span className={styles.baseBranch}>{baseBranch}</span>
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

  const repoMap = useMemo(
    () => new Map(repositories.map((r) => [r.id, r])),
    [repositories]
  );

  const remoteNameMap = useMemo(
    () => new Map(remoteConnections.map((c) => [c.id, c.name])),
    [remoteConnections]
  );

  const activeWorkspaces = workspaces.filter((ws) => ws.status === "Active");

  if (activeWorkspaces.length === 0) {
    return (
      <div className={styles.empty}>
        <Layers size={40} className={styles.emptyIcon} />
        <span className={styles.emptyTitle}>No active workspaces</span>
        <p className={styles.hint}>
          Create a workspace from a repository in the sidebar, or press{" "}
          <kbd className={styles.hintKey}>+</kbd> next to a repo name.
        </p>
      </div>
    );
  }

  const runningCount = activeWorkspaces.filter(
    (ws) => ws.agent_status === "Running"
  ).length;

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>
        Active Workspaces
        {runningCount > 0 && (
          <span className={styles.headerCount}>
            {runningCount} running
          </span>
        )}
      </div>
      <div className={styles.grid}>
        {activeWorkspaces.map((ws, i) => {
          const repo = repoMap.get(ws.repository_id);
          return (
            <WorkspaceCard
              key={ws.id}
              ws={ws}
              repo={repo}
              baseBranch={repo ? defaultBranches[repo.id] : undefined}
              lastMsg={lastMessages[ws.id]}
              remoteName={ws.remote_connection_id ? remoteNameMap.get(ws.remote_connection_id) : undefined}
              onClick={selectWorkspace}
              index={i}
            />
          );
        })}
      </div>
    </div>
  );
}
