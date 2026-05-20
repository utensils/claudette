import { CircleDot } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import styles from "./Sidebar.module.css";

export interface WorkspaceScmLinkIconProps {
  workspaceId: string;
}

/// Small indicator on a sidebar workspace row when that workspace was
/// spun up for a specific issue/PR via the project-view "Send to new
/// workspace" gesture. Informational — the tooltip names the item;
/// clicking the row already selects the workspace.
///
/// Gated behind `projectViewIssuesPrsEnabled`: the association is part
/// of the project-view issues/PRs feature, so it stays invisible
/// whenever that feature is turned off.
export function WorkspaceScmLinkIcon({ workspaceId }: WorkspaceScmLinkIconProps) {
  const enabled = useAppStore((s) => s.projectViewIssuesPrsEnabled);
  const link = useAppStore((s) => s.workspaceScmLinks[workspaceId]);
  if (!enabled || !link) return null;
  const prefix = link.kind === "pr" ? "PR" : "Issue";
  return (
    <span
      className={styles.wsScmLink}
      title={`${prefix} #${link.number} — ${link.title}`}
      aria-label={`${prefix} #${link.number}: ${link.title}`}
      role="img"
    >
      <CircleDot size={11} />
    </span>
  );
}
