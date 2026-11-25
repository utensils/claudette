import { CircleDot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import type { ResolvedWorkspaceLink } from "./workspaceScmLink";
import styles from "./RepoListsSection.module.css";

export interface WorkspaceLinkBadgeProps {
  link: ResolvedWorkspaceLink;
}

/// "In progress" indicator shown on a project-view issue/PR row that
/// already has a workspace working on it. Clicking jumps straight to
/// that workspace. `stopPropagation` keeps the click off the row's
/// open-in-browser handler.
export function WorkspaceLinkBadge({ link }: WorkspaceLinkBadgeProps) {
  const { t } = useTranslation();
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  return (
    <button
      type="button"
      className={styles.workspaceBadge}
      title={t("repo_link_badge_title", { name: link.workspaceName })}
      aria-label={t("repo_link_badge_aria", { name: link.workspaceName })}
      onClick={(e) => {
        e.stopPropagation();
        selectWorkspace(link.workspaceId);
      }}
      onKeyDown={(e) => {
        // The enclosing row is a `role="button"` that opens the
        // issue/PR URL on Enter/Space. Keep the badge's own keyboard
        // activation from also bubbling up and firing that handler.
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation();
        }
      }}
    >
      <CircleDot size={10} aria-hidden />
      <span className={styles.workspaceBadgeName}>{link.workspaceName}</span>
    </button>
  );
}
