import { GitBranch } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { WorkspaceActions } from "../chat/WorkspaceActions";
import { PanelToggles } from "./PanelToggles";
import { PanelHeader } from "./PanelHeader";
import styles from "./WorkspacePanelHeader.module.css";

/** Header shown above an active workspace's chat view. The drag/title-bar
 *  chrome is delegated to the shared `PanelHeader` so the global Dashboard
 *  and project-scoped views render identical-feeling toolbars. Only the
 *  workspace-specific breadcrumb (repo/branch/base) and action group live
 *  here. */
export function WorkspacePanelHeader() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const defaultBranchesMap = useAppStore((s) => s.defaultBranches);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const defaultBranch = repo ? defaultBranchesMap[repo.id] : undefined;

  const left =
    ws && (repo ? (
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
    ));

  return (
    <PanelHeader
      left={left}
      right={
        <>
          <WorkspaceActions worktreePath={ws?.worktree_path ?? null} />
          <PanelToggles />
        </>
      }
    />
  );
}
