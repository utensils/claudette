import type { MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GitBranch } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { WorkspaceActions } from "../chat/WorkspaceActions";
import { PanelToggles } from "./PanelToggles";
import styles from "./WorkspacePanelHeader.module.css";

export function WorkspacePanelHeader() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const defaultBranchesMap = useAppStore((s) => s.defaultBranches);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const defaultBranch = repo ? defaultBranchesMap[repo.id] : undefined;

  const handleHeaderLabelMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startDragging().catch((err) => {
      console.error("Failed to start window drag from header label:", err);
    });
  };

  return (
    <div className={`${styles.header} ${!sidebarVisible ? styles.noSidebar : ""}`} data-tauri-drag-region>
      <div className={styles.headerLeft} onMouseDown={handleHeaderLabelMouseDown}>
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
        <WorkspaceActions
          worktreePath={ws?.worktree_path ?? null}
        />
        <PanelToggles />
      </div>
    </div>
  );
}
