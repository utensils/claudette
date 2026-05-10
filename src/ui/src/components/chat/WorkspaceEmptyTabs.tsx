import { memo } from "react";
import { Plus, Command, FolderGit2, X } from "lucide-react";
import { executeNewTab } from "../../hotkeys/contextActions";
import { useAppStore } from "../../stores/useAppStore";
import { getHotkeyLabel } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import type { Workspace } from "../../types/workspace";
import type { Repository } from "../../types/repository";
import { RepoIcon } from "../shared/RepoIcon";
// Reuse the welcome card's visual chrome — same scoped class names, no
// style duplication. CSS modules share scope across consumers of the
// same .module.css file, so importing it here gives us the identical
// card look the user explicitly asked for ("this same screen").
import styles from "../layout/WelcomeEmptyState.module.css";

export interface WorkspaceEmptyTabsProps {
  workspace: Workspace;
  repository: Repository | undefined;
}

/** Empty state shown when a workspace has zero open tabs (no chat sessions,
 *  no diff tabs, no file tabs). The strip's `+` button is still visible
 *  above this card; the card just makes the keyboard shortcut and the
 *  intent obvious so the user isn't staring at a blank pane. */
export const WorkspaceEmptyTabs = memo(function WorkspaceEmptyTabs({
  workspace,
  repository,
}: WorkspaceEmptyTabsProps) {
  const keybindings = useAppStore((s) => s.keybindings);
  const isMac = isMacHotkeyPlatform();
  const newTabLabel = getHotkeyLabel("global.new-tab", keybindings, isMac) ?? "Cmd+T";
  const closeTabLabel = getHotkeyLabel("global.close-tab", keybindings, isMac) ?? "Cmd+W";

  return (
    <div className={styles.welcome}>
      <div className={styles.card}>
        <h1 className={styles.title}>No open tabs in {workspace.name}.</h1>
        <p className={styles.subtitle}>
          Closing every tab leaves the workspace itself running — start a new
          chat session, diff, or file tab to keep working here.
        </p>

        {repository && (
          <div className={styles.activeProject} aria-disabled="true">
            {repository.icon && (
              <RepoIcon
                icon={repository.icon}
                size={14}
                className={styles.activeProjectIcon}
              />
            )}
            <span className={styles.activeProjectName}>{repository.name}</span>
            <span className={styles.activeProjectPath}>
              {workspace.branch_name}
            </span>
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={() => executeNewTab()}
          >
            <Plus size={14} />
            New Session
          </button>
        </div>

        <section className={styles.section}>
          <h2 className={styles.sectionLabel}>Tips</h2>
          <ul className={styles.tips}>
            <li>
              <Command size={12} className={styles.tipIcon} />
              <span>
                <kbd className={styles.kbd}>{newTabLabel}</kbd> opens a new
                chat session in this workspace.
              </span>
            </li>
            <li>
              <X size={12} className={styles.tipIcon} />
              <span>
                <kbd className={styles.kbd}>{closeTabLabel}</kbd> closes the
                active tab — handy when you want to clean up.
              </span>
            </li>
            <li>
              <FolderGit2 size={12} className={styles.tipIcon} />
              <span>
                Click the <strong>+</strong> in the tab strip above for the
                same effect, plus a context menu for resumable Claude
                sessions.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
});
