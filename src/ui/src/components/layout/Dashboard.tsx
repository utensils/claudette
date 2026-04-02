import { GitBranch } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import styles from "./Dashboard.module.css";

export function Dashboard() {
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const lastMessages = useAppStore((s) => s.lastMessages);
  const defaultBranches = useAppStore((s) => s.defaultBranches);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const activeWorkspaces = workspaces.filter((ws) => ws.status === "Active");

  if (activeWorkspaces.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No active workspaces</p>
        <p className={styles.hint}>
          Create a workspace from a repository in the sidebar
        </p>
      </div>
    );
  }

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>Active Workspaces</div>
      <div className={styles.grid}>
        {activeWorkspaces.map((ws) => {
          const repo = repositories.find((r) => r.id === ws.repository_id);
          const lastMsg = lastMessages[ws.id];
          const baseBranch = repo ? defaultBranches[repo.id] : undefined;

          return (
            <button
              key={ws.id}
              className={styles.card}
              onClick={() => selectWorkspace(ws.id)}
            >
              <div className={styles.cardHeader}>
                <span className={styles.repoName}>
                  {repo?.icon && `${repo.icon} `}
                  {repo?.name ?? "Unknown"}
                </span>
                <span
                  className={styles.statusDot}
                  style={{
                    background:
                      ws.agent_status === "Running"
                        ? "var(--status-running)"
                        : "var(--status-idle)",
                  }}
                />
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
                    {lastMsg.content.slice(0, 120)}
                    {lastMsg.content.length > 120 ? "..." : ""}
                  </span>
                </div>
              ) : (
                <div className={styles.noMessages}>No messages yet</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
