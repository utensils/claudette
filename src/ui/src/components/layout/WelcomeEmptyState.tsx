import { memo, useMemo } from "react";
import { FolderPlus, Plus, Command, FolderGit2 } from "lucide-react";
import type { Repository } from "../../types/repository";
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
    title ?? (hasRepos ? "Ready when you are." : "Let's set up your first project.");
  const resolvedSubtitle =
    subtitle ??
    (hasRepos
      ? "No active workspaces yet. Create one to start a conversation with Claude."
      : "Add a project — Claudette will create a git worktree and a Claude session for it.");

  return (
    <div className={styles.welcome}>
      <div className={styles.card}>
        <h1 className={styles.title}>{resolvedTitle}</h1>
        <p className={styles.subtitle}>{resolvedSubtitle}</p>

        {suggestedRepo && (
          <button
            type="button"
            className={styles.activeProject}
            onClick={() => onCreateWorkspace(suggestedRepo.id)}
            disabled={creating}
            title={`Create a workspace in ${suggestedRepo.name}`}
          >
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
              Create Workspace
            </button>
          )}
          <button
            type="button"
            className={hasRepos ? styles.secondary : styles.primary}
            onClick={onAddRepository}
          >
            <FolderPlus size={14} />
            {hasRepos ? "Add Repository…" : "Add Your First Repository…"}
          </button>
        </div>

        {orderedRepos.length > 1 && (
          <section className={styles.section}>
            <h2 className={styles.sectionLabel}>Your Projects</h2>
            <ul className={styles.projectList}>
              {orderedRepos.map((repo) => (
                <li key={repo.id}>
                  <button
                    type="button"
                    className={styles.projectRow}
                    onClick={() => onCreateWorkspace(repo.id)}
                    disabled={creating}
                    title={`Create a workspace in ${repo.name}`}
                  >
                    {repo.icon && (
                      <RepoIcon
                        icon={repo.icon}
                        size={13}
                        className={styles.projectRowIcon}
                      />
                    )}
                    <span className={styles.projectRowName}>{repo.name}</span>
                    <span className={styles.projectRowPath}>{repo.path}</span>
                    {!repo.path_valid && (
                      <span className={styles.projectRowMissing}>missing</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.section}>
          <h2 className={styles.sectionLabel}>Tips</h2>
          <ul className={styles.tips}>
            <li>
              <FolderGit2 size={12} className={styles.tipIcon} />
              <span>
                Click a project above (or press{" "}
                <kbd className={styles.kbd}>+</kbd> next to it in the sidebar)
                to spin up a fresh workspace.
              </span>
            </li>
            <li>
              <Command size={12} className={styles.tipIcon} />
              <span>
                Press <kbd className={styles.kbd}>⌘K</kbd> to open the command
                palette.
              </span>
            </li>
            <li>
              <Plus size={12} className={styles.tipIcon} />
              <span>
                Each workspace gets its own git worktree, so agents can't step
                on each other's branches.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
});
