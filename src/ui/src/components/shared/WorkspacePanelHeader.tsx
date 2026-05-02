import { GitBranch } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { WorkspaceActions } from "../chat/WorkspaceActions";
import { ParticipantsRoster } from "../chat/ParticipantsRoster";
import { PanelToggles } from "./PanelToggles";
import styles from "./WorkspacePanelHeader.module.css";

export function WorkspacePanelHeader() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const activeSessionId = useAppStore((s) =>
    s.selectedWorkspaceId
      ? s.selectedSessionIdByWorkspaceId[s.selectedWorkspaceId] ?? null
      : null,
  );
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const defaultBranchesMap = useAppStore((s) => s.defaultBranches);
  // Resolve the local user's participant id for the active workspace's
  // chat sessions: the host sentinel for local workspaces, or the remote
  // server's stored participant id for paired remote workspaces.
  const selfParticipantId = useAppStore((s) => {
    const w = selectedWorkspaceId
      ? s.workspaces.find((ws2) => ws2.id === selectedWorkspaceId)
      : null;
    if (!w) return null;
    if (!w.remote_connection_id) return "host";
    const conn = s.remoteConnections.find(
      (c) => c.id === w.remote_connection_id,
    );
    return conn?.participant_id ?? null;
  });

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const defaultBranch = repo ? defaultBranchesMap[repo.id] : undefined;

  return (
    <div className={styles.header} data-tauri-drag-region>
      <div className={styles.headerLeft}>
        {ws && (repo ? (
          <span className={styles.branchInfo}>
            <span className={styles.repoName}>{repo.name}</span>
            <span className={styles.branchSep}>/</span>
            <GitBranch size={12} className={styles.branchIcon} />
            <span className={styles.branchName}>{ws.branch_name}</span>
            {defaultBranch && (
              <>
                <span className={styles.branchArrow}>{">"}</span>
                <span className={styles.baseBranch}>
                  {defaultBranch.replace(/^origin\//, "")}
                </span>
              </>
            )}
          </span>
        ) : (
          <span className={styles.repoName}>{ws.name}</span>
        ))}
      </div>
      <div className={styles.headerRight}>
        {activeSessionId && (
          <ParticipantsRoster
            sessionId={activeSessionId}
            selfParticipantId={selfParticipantId}
          />
        )}
        <WorkspaceActions
          worktreePath={ws?.worktree_path ?? null}
        />
        <PanelToggles />
      </div>
    </div>
  );
}
