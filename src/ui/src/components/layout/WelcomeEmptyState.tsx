import { memo, useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import { FolderPlus, Plus, Command, FolderGit2, Search, Layers } from "lucide-react";
import type { Repository } from "../../types/repository";
import { useAppStore } from "../../stores/useAppStore";
import { getHotkeyLabel } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import { RepoIcon } from "../shared/RepoIcon";
import styles from "./WelcomeEmptyState.module.css";

export interface WelcomeEmptyStateProps {
  /** All locally-added repositories. Remote-only repos should be filtered out by the caller. */
  repositories: Repository[];
  /** Repo IDs sorted by recency (most recent first). The first entry — if present — is
   *  used as the target for the primary "Create Workspace" CTA. */
  recentRepoIds: string[];
  /** Triggered by the primary CTA and by clicking a repo row. */
  onCreateWorkspace: (repoId: string) => void;
  /** Triggered by the secondary "Add Repository" CTA. */
  onAddRepository: () => void;
  /** True when a workspace creation is already in flight; used to dim the primary CTA so
   *  the user can't double-click into a race. */
  creating?: boolean;
  /** Optional headline override. Defaults to a context-neutral greeting; the
   *  project-scoped view in Dashboard passes a title that names the selected
   *  project so "Welcome to Claudette" doesn't feel like a first-run banner
   *  on every navigation. */
  title?: string;
  /** Optional sub-headline override paired with `title`. Defaults flex on the
   *  presence of repositories so the zero-repo case reads as onboarding. */
  subtitle?: string;
}

/** Welcome card shown on the Dashboard when no active workspaces exist. Replaces the
 *  bland "No active workspaces" hint that previously left first-time users guessing. */
export const WelcomeEmptyState = memo(function WelcomeEmptyState({
  repositories,
  recentRepoIds,
  onCreateWorkspace,
  onAddRepository,
  creating = false,
  title,
  subtitle,
}: WelcomeEmptyStateProps) {
  const { t } = useTranslation();
  // Per-row workspace counts give each project chip something more concrete
  // than just its path — a "3 active" badge tells the user where their
  // ongoing work lives without making them open the project to find out.
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspaceCountByRepo = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ws of workspaces) {
      if (ws.status !== "Active") continue;
      counts.set(ws.repository_id, (counts.get(ws.repository_id) ?? 0) + 1);
    }
    return counts;
  }, [workspaces]);

  // Hotkey labels are pulled live from the user's keybinding map so the
  // tips section stays correct after a rebind from Settings → Keyboard.
  const keybindings = useAppStore((s) => s.keybindings);
  const isMac = isMacHotkeyPlatform();
  const newWorkspaceLabel =
    getHotkeyLabel("global.new-workspace", keybindings, isMac) ?? "⌘⇧N";
  const fuzzyFinderLabel =
    getHotkeyLabel("global.toggle-fuzzy-finder", keybindings, isMac) ?? "⌘K";
  const commandPaletteLabel =
    getHotkeyLabel("global.toggle-command-palette", keybindings, isMac) ?? "⌘P";

  // Project rows render in recency order, falling back to sidebar sort_order for repos
  // that have never had a workspace (and therefore no last-message timestamp).
  const orderedRepos = useMemo(() => {
    const recencyRank = new Map(recentRepoIds.map((id, i) => [id, i]));
    const fallbackBase = recentRepoIds.length;
    return [...repositories].sort((a, b) => {
      const ra = recencyRank.get(a.id) ?? fallbackBase + a.sort_order;
      const rb = recencyRank.get(b.id) ?? fallbackBase + b.sort_order;
      return ra - rb;
    });
  }, [repositories, recentRepoIds]);

  const suggestedRepo = useMemo(() => {
    if (orderedRepos.length === 0) return null;
    const recentTop = recentRepoIds.find((id) =>
      orderedRepos.some((r) => r.id === id)
    );
    return (
      orderedRepos.find((r) => r.id === recentTop) ?? orderedRepos[0]
    );
  }, [orderedRepos, recentRepoIds]);

  const hasRepos = orderedRepos.length > 0;

  // Default headline avoids "Welcome to Claudette" because the card also
  // appears in non-first-run states (returning user with no active
  // workspace, project-scoped view). "Ready when you are." reads as the
  // assistant's standby rather than a launch screen.
  const resolvedTitle =
    title ??
    (hasRepos ? t("welcome_title_ready") : t("welcome_title_setup"));
  const resolvedSubtitle =
    subtitle ??
    (hasRepos
      ? t("welcome_subtitle_ready")
      : t("welcome_subtitle_setup"));

  const suggestedActiveCount = suggestedRepo
    ? activeWorkspaceCountByRepo.get(suggestedRepo.id) ?? 0
    : 0;

  return (
    <div className={styles.welcome}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1 className={styles.title}>{resolvedTitle}</h1>
          <p className={styles.subtitle}>{resolvedSubtitle}</p>
        </div>

        {suggestedRepo && (
          <button
            type="button"
            className={styles.activeProject}
            onClick={() => onCreateWorkspace(suggestedRepo.id)}
            disabled={creating}
            title={t("welcome_create_in", { name: suggestedRepo.name })}
          >
            <span className={styles.activeProjectHead}>
              {suggestedRepo.icon && (
                <RepoIcon
                  icon={suggestedRepo.icon}
                  size={14}
                  className={styles.activeProjectIcon}
                />
              )}
              <span className={styles.activeProjectName}>
                {suggestedRepo.name}
              </span>
              <span className={styles.activeProjectPath}>
                {suggestedRepo.path}
              </span>
            </span>
            <span className={styles.activeProjectMeta}>
              <span>
                <Layers size={11} aria-hidden="true" />
                {t("welcome_active_workspaces", { count: suggestedActiveCount })}
              </span>
              {!suggestedRepo.path_valid && (
                <span className={styles.projectRowMissing}>{t("welcome_path_missing")}</span>
              )}
            </span>
          </button>
        )}

        <div className={styles.actions}>
          {hasRepos && suggestedRepo && (
            <button
              type="button"
              className={styles.primary}
              onClick={() => onCreateWorkspace(suggestedRepo.id)}
              disabled={creating}
            >
              <Plus size={14} />
              {t("welcome_create_workspace")}
            </button>
          )}
          <button
            type="button"
            className={hasRepos ? styles.secondary : styles.primary}
            onClick={onAddRepository}
          >
            <FolderPlus size={14} />
            {hasRepos ? t("welcome_add_repository") : t("welcome_add_first_repository")}
          </button>
        </div>

        {orderedRepos.length > 1 && (
          <section className={styles.section}>
            <h2 className={styles.sectionLabel}>{t("welcome_your_projects")}</h2>
            <ul className={styles.projectList}>
              {orderedRepos.map((repo) => {
                const count = activeWorkspaceCountByRepo.get(repo.id) ?? 0;
                return (
                  <li key={repo.id}>
                    <button
                      type="button"
                      className={styles.projectRow}
                      onClick={() => onCreateWorkspace(repo.id)}
                      disabled={creating}
                      title={t("welcome_create_in", { name: repo.name })}
                    >
                      {repo.icon ? (
                        <RepoIcon
                          icon={repo.icon}
                          size={14}
                          className={styles.projectRowIcon}
                        />
                      ) : (
                        <FolderGit2 size={14} className={styles.projectRowIcon} aria-hidden="true" />
                      )}
                      <span className={styles.projectRowBody}>
                        <span className={styles.projectRowName}>{repo.name}</span>
                        <span className={styles.projectRowPath}>{repo.path}</span>
                      </span>
                      <span className={styles.projectRowMeta}>
                        {count > 0 && (
                          <span>
                            {t("welcome_workspace_count", { count })}
                          </span>
                        )}
                        {!repo.path_valid && (
                          <span className={styles.projectRowMissing}>{t("welcome_missing")}</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className={styles.section}>
          <h2 className={styles.sectionLabel}>{t("welcome_tips")}</h2>
          <ul className={styles.tips}>
            <li>
              <FolderGit2 size={12} className={styles.tipIcon} />
              <span>
                <Trans
                  i18nKey="welcome_tip_new_workspace"
                  values={{ shortcut: newWorkspaceLabel }}
                  components={{ kbd: <kbd className={styles.kbd} /> }}
                />
              </span>
            </li>
            <li>
              <Search size={12} className={styles.tipIcon} />
              <span>
                <Trans
                  i18nKey="welcome_tip_fuzzy_finder"
                  values={{ shortcut: fuzzyFinderLabel }}
                  components={{ kbd: <kbd className={styles.kbd} /> }}
                />
              </span>
            </li>
            <li>
              <Command size={12} className={styles.tipIcon} />
              <span>
                <Trans
                  i18nKey="welcome_tip_command_palette"
                  values={{ shortcut: commandPaletteLabel }}
                  components={{ kbd: <kbd className={styles.kbd} /> }}
                />
              </span>
            </li>
            <li>
              <Plus size={12} className={styles.tipIcon} />
              <span>{t("welcome_tip_worktree")}</span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
});
