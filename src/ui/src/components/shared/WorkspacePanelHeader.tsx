import { CircleDot, GitBranch } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { openUrl } from "../../services/tauri";
import { WorkspaceActions } from "../chat/WorkspaceActions";
import { InteractiveTerminalModeToggle } from "../chat/InteractiveTerminalModeToggle";
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
  // The issue/PR breadcrumb is part of the project-view issues/PRs
  // feature, so it stays gated behind the same flag.
  const projectViewEnabled = useAppStore((s) => s.projectViewIssuesPrsEnabled);
  const scmLink = useAppStore((s) =>
    selectedWorkspaceId ? s.workspaceScmLinks[selectedWorkspaceId] : undefined,
  );

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const defaultBranch = repo ? defaultBranchesMap[repo.id] : undefined;

  // "What is this workspace for" — the issue/PR it was spun up against.
  // Clicking opens the source in the browser.
  const scmLinkEl =
    projectViewEnabled && scmLink ? (
      <button
        type="button"
        className={styles.scmLink}
        title={`${scmLink.kind === "pr" ? "PR" : "Issue"} #${scmLink.number}: ${scmLink.title} — open in browser`}
        onClick={() => void openUrl(scmLink.url)}
      >
        <CircleDot size={11} className={styles.scmLinkIcon} aria-hidden />
        <span className={styles.scmLinkNumber}>#{scmLink.number}</span>
        <span className={styles.scmLinkTitle}>{scmLink.title}</span>
      </button>
    ) : null;

  const left = ws ? (
    <span className={styles.headerLeft}>
      {repo ? (
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
      )}
      {scmLinkEl}
    </span>
  ) : null;

  return (
    <PanelHeader
      left={left}
      right={
        <>
          <InteractiveTerminalModeToggle />
          <WorkspaceActions worktreePath={ws?.worktree_path ?? null} />
          <PanelToggles />
        </>
      }
    />
  );
}
