import { CircleDot } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const enabled = useAppStore((s) => s.projectViewIssuesPrsEnabled);
  const link = useAppStore((s) => s.workspaceScmLinks[workspaceId]);
  if (!enabled || !link) return null;
  const prefix =
    link.kind === "pr"
      ? t("workspace_header_kind_pr")
      : t("workspace_header_kind_issue");
  return (
    <span
      className={styles.wsScmLink}
      title={t("sidebar_scm_link_title", { kind: prefix, number: link.number, title: link.title })}
      aria-label={t("sidebar_scm_link_aria", { kind: prefix, number: link.number, title: link.title })}
      role="img"
    >
      <CircleDot size={11} />
    </span>
  );
}
