import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import { RepoIcon } from "../../shared/RepoIcon";
import { formatBytes } from "../../../utils/formatBytes";
import {
  computeStorageStats,
  scanOrphanedWorktrees,
  purgeOrphanedWorktree,
  type OrphanedWorktree,
  type RepoStorageStats,
  type WorkspaceStorageEntry,
} from "../../../services/tauri";
import styles from "../Settings.module.css";

/**
 * Unified per-repo card the Storage page actually renders. A single row
 * carries the repo's archived count, on-disk totals, AND any orphaned
 * worktree dirs whose slug points back to it. Synthetic cards (no DB
 * `repo`) cover the "DB was nuked" case where orphans exist under a
 * slug that no longer maps to any registered repository.
 */
interface UnifiedRepoCard {
  /** Stable key for React + expand-state map. */
  key: string;
  /** Display name — repo.name for real repos, slug for synthetic. */
  displayName: string;
  /** Optional repo for icon + click-into-cleanup-modal. */
  repo: { id: string; icon: string | null } | null;
  archivedCount: number;
  activeBytes: number;
  archivedBytes: number;
  orphanedBytes: number;
  totalBytes: number;
  workspaces: WorkspaceStorageEntry[];
  orphans: OrphanedWorktree[];
}

export function StorageSettings() {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const openModal = useAppStore((s) => s.openModal);

  const [stats, setStats] = useState<RepoStorageStats[] | null>(null);
  const [orphans, setOrphans] = useState<OrphanedWorktree[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState<Set<string>>(new Set());
  const [confirmPath, setConfirmPath] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([computeStorageStats(), scanOrphanedWorktrees()])
      .then(([s, o]) => {
        setStats(s);
        setOrphans(o);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const localRepos = useMemo(
    () => repositories.filter((r) => !r.remote_connection_id),
    [repositories],
  );

  const archivedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ws of workspaces) {
      if (ws.status !== "Archived") continue;
      if (ws.remote_connection_id) continue;
      counts.set(ws.repository_id, (counts.get(ws.repository_id) ?? 0) + 1);
    }
    return counts;
  }, [workspaces]);

  /**
   * Fold stats + orphans into a single list of unified cards. Orphans
   * whose slug matches a tracked repo are nested under that repo. Orphans
   * whose slug doesn't match get bundled into synthetic "Unknown repo"
   * cards keyed by slug, surfaced at the top of the list so the user
   * sees the alarming case first.
   */
  const cards = useMemo<UnifiedRepoCard[]>(() => {
    const statsById = new Map(stats?.map((s) => [s.repository_id, s]) ?? []);
    const orphansBySlug = new Map<string, OrphanedWorktree[]>();
    const unknownBySlug = new Map<string, OrphanedWorktree[]>();
    for (const o of orphans ?? []) {
      const bucket = o.inferred_repo_name ? orphansBySlug : unknownBySlug;
      const slug = o.inferred_repo_slug;
      const arr = bucket.get(slug) ?? [];
      arr.push(o);
      bucket.set(slug, arr);
    }

    const knownCards: UnifiedRepoCard[] = localRepos.map((repo) => {
      const s = statsById.get(repo.id);
      // Match orphans by slug — the backend stamps `inferred_repo_name`
      // when the slug resolves, but the slug itself is what we group on.
      const matched = (orphans ?? []).filter(
        (o) =>
          o.inferred_repo_name != null && o.inferred_repo_slug === repo.path_slug,
      );
      const orphanedBytes = matched.reduce(
        (sum, o) => sum + (o.size_bytes ?? 0),
        0,
      );
      return {
        key: `repo:${repo.id}`,
        displayName: repo.name,
        repo: { id: repo.id, icon: repo.icon ?? null },
        archivedCount: archivedCounts.get(repo.id) ?? 0,
        activeBytes: s?.active_bytes ?? 0,
        archivedBytes: s?.archived_bytes ?? 0,
        orphanedBytes,
        totalBytes: (s?.total_bytes ?? 0) + orphanedBytes,
        workspaces: s?.workspaces ?? [],
        orphans: matched,
      };
    });

    const unknownCards: UnifiedRepoCard[] = [...unknownBySlug.entries()].map(
      ([slug, orphList]) => {
        const orphanedBytes = orphList.reduce(
          (sum, o) => sum + (o.size_bytes ?? 0),
          0,
        );
        return {
          key: `unknown:${slug}`,
          displayName: slug,
          repo: null,
          archivedCount: 0,
          activeBytes: 0,
          archivedBytes: 0,
          orphanedBytes,
          totalBytes: orphanedBytes,
          workspaces: [],
          orphans: orphList,
        };
      },
    );

    // Surface unknown-repo (alarming, destructive) cards first, then
    // sort known repos by total disk used desc so the biggest offenders
    // come up first.
    return [
      ...unknownCards.sort((a, b) => b.totalBytes - a.totalBytes),
      ...knownCards.sort((a, b) => b.totalBytes - a.totalBytes),
    ];
  }, [stats, orphans, localRepos, archivedCounts]);

  const totalArchivedAcrossAllRepos = useMemo(
    () => cards.reduce((sum, c) => sum + c.archivedCount, 0),
    [cards],
  );
  const totalOrphanedCount = useMemo(
    () => orphans?.length ?? 0,
    [orphans],
  );
  const hasAnythingToClean =
    totalArchivedAcrossAllRepos > 0 || totalOrphanedCount > 0;

  const toggleExpanded = (cardKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cardKey)) next.delete(cardKey);
      else next.add(cardKey);
      return next;
    });
  };

  const handleOrphanPurge = async (path: string) => {
    setPurging((prev) => new Set(prev).add(path));
    setError(null);
    try {
      await purgeOrphanedWorktree(path);
      setOrphans((prev) => prev?.filter((r) => r.path !== path) ?? null);
      // Re-pull stats so totals stay accurate.
      computeStorageStats().then(setStats).catch(() => {});
      setConfirmPath(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setPurging((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  };

  return (
    <div>
      <div className={styles.storageHeader}>
        <div className={styles.storageHeaderText}>
          <h2 className={styles.sectionTitle}>{t("storage_section_title")}</h2>
          <p className={styles.sectionDescription}>
            {t("storage_section_description", {
              total: totalArchivedAcrossAllRepos,
            })}
          </p>
        </div>
        <div className={styles.storageHeaderActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={refresh}
            disabled={loading}
            title={t("storage_rescan_tooltip")}
          >
            <RefreshCw size={12} />
            {loading ? t("storage_rescanning") : t("storage_rescan")}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => openModal("bulkCleanupArchived", { repoId: null })}
            disabled={totalArchivedAcrossAllRepos === 0}
          >
            {t("storage_cleanup_all_button", {
              count: totalArchivedAcrossAllRepos,
            })}
          </button>
        </div>
      </div>

      {error && !confirmPath && (
        <div className={styles.storageError}>{error}</div>
      )}

      {loading && !stats && (
        <div className={styles.fieldHint}>{t("storage_loading")}</div>
      )}

      {!loading && cards.length === 0 && (
        <div className={styles.fieldHint}>{t("storage_no_repos")}</div>
      )}

      {!loading && cards.length > 0 && !hasAnythingToClean && (
        <div className={styles.storageEmptyHint}>
          {t("storage_no_cleanup_needed")}
        </div>
      )}

      {cards.map((card) => (
        <RepoCard
          key={card.key}
          card={card}
          expanded={expanded.has(card.key)}
          onToggle={() => toggleExpanded(card.key)}
          onPurgeOrphan={(p) => setConfirmPath(p)}
          onOpenArchivedCleanup={(repoId) =>
            openModal("bulkCleanupArchived", { repoId })
          }
          purging={purging}
        />
      ))}

      {confirmPath && (
        <div className={styles.storageOrphanConfirmOverlay}>
          <div className={styles.storageOrphanConfirmCard}>
            <div className={styles.storageOrphanConfirmText}>
              {t("storage_orphaned_confirm", { path: confirmPath })}
            </div>
            {error && (
              <div className={styles.storageOrphanConfirmError}>{error}</div>
            )}
            <div className={styles.storageOrphanConfirmActions}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => {
                  setConfirmPath(null);
                  setError(null);
                }}
                disabled={purging.has(confirmPath)}
              >
                {tCommon("cancel")}
              </button>
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.storageOrphanConfirmDelete}`}
                onClick={() => handleOrphanPurge(confirmPath)}
                disabled={purging.has(confirmPath)}
              >
                <Trash2 size={12} />
                {purging.has(confirmPath)
                  ? t("storage_orphaned_deleting")
                  : t("storage_orphaned_confirm_button")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface RepoCardProps {
  card: UnifiedRepoCard;
  expanded: boolean;
  onToggle: () => void;
  onPurgeOrphan: (path: string) => void;
  onOpenArchivedCleanup: (repoId: string) => void;
  purging: Set<string>;
}

function RepoCard({
  card,
  expanded,
  onToggle,
  onPurgeOrphan,
  onOpenArchivedCleanup,
  purging,
}: RepoCardProps) {
  const { t } = useTranslation("settings");
  const isUnknown = card.repo === null;
  const hasDetails = card.workspaces.length + card.orphans.length > 0;

  return (
    <div
      className={
        isUnknown ? styles.storageUnknownCard : styles.storageRepoCard
      }
    >
      <div className={styles.storageCardHeader}>
        <button
          type="button"
          className={styles.storageCardChevron}
          onClick={hasDetails ? onToggle : undefined}
          disabled={!hasDetails}
          aria-label={t("storage_toggle_breakdown")}
        >
          {hasDetails ? (
            expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <span className={styles.storageCardChevronSpacer} />
          )}
        </button>
        <div className={styles.storageCardMain}>
          <div className={styles.storageCardTitle}>
            {isUnknown ? (
              <AlertTriangle
                size={14}
                className={styles.storageUnknownIcon}
                aria-hidden
              />
            ) : (
              card.repo?.icon && (
                <RepoIcon
                  icon={card.repo.icon}
                  size={14}
                  className={styles.repoIcon}
                />
              )
            )}
            <span className={styles.storageCardName}>
              {isUnknown ? t("storage_unknown_repo_title") : card.displayName}
            </span>
            {isUnknown && (
              <span className={styles.storageCardSlugBadge}>
                {card.displayName}
              </span>
            )}
            <span className={styles.storageCardTotal}>
              {formatBytes(card.totalBytes)}
            </span>
          </div>
          <div className={styles.storageCardMeta}>
            {isUnknown ? (
              <span>{t("storage_unknown_repo_hint")}</span>
            ) : (
              <CardMetaPills card={card} />
            )}
          </div>
        </div>
        <div className={styles.storageCardActions}>
          {!isUnknown && card.archivedCount > 0 && card.repo && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => onOpenArchivedCleanup(card.repo!.id)}
            >
              {t("storage_cleanup_button")}
            </button>
          )}
        </div>
      </div>

      {expanded && hasDetails && (
        <div className={styles.storageCardBreakdown}>
          {card.workspaces.map((ws) => (
            <div key={ws.id} className={styles.storageWorkspaceRow}>
              <span className={styles.storageWorkspaceName}>{ws.name}</span>
              <span
                className={
                  ws.status === "Archived"
                    ? styles.storageStatusPillArchived
                    : styles.storageStatusPillActive
                }
              >
                {ws.status === "Archived"
                  ? t("storage_status_archived")
                  : t("storage_status_active")}
              </span>
              <span className={styles.storageWorkspaceSize}>
                {ws.size_bytes != null
                  ? formatBytes(ws.size_bytes)
                  : t("storage_size_missing")}
              </span>
            </div>
          ))}
          {card.orphans.map((o) => {
            const isPurging = purging.has(o.path);
            return (
              <div
                key={o.path}
                className={styles.storageOrphanRow}
                title={o.path}
              >
                <span className={styles.storageOrphanPath}>{o.path}</span>
                <span className={styles.storageStatusPillOrphaned}>
                  {t("storage_status_orphaned")}
                </span>
                <span className={styles.storageWorkspaceSize}>
                  {formatBytes(o.size_bytes)}
                </span>
                <button
                  type="button"
                  className={styles.storageOrphanDeleteBtn}
                  disabled={isPurging}
                  onClick={() => onPurgeOrphan(o.path)}
                  title={t("storage_orphaned_delete")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CardMetaPills({ card }: { card: UnifiedRepoCard }) {
  const { t } = useTranslation("settings");
  return (
    <>
      {card.activeBytes > 0 && (
        <span className={styles.storageMetaPill}>
          {t("storage_summary_active", { size: formatBytes(card.activeBytes) })}
        </span>
      )}
      {card.archivedCount > 0 && (
        <span className={styles.storageMetaPill}>
          {t("storage_summary_archived", {
            size: formatBytes(card.archivedBytes),
          })}
          {" · "}
          {t(
            card.archivedCount === 1
              ? "storage_archived_label_singular"
              : "storage_archived_label_plural",
            { count: card.archivedCount },
          )}
        </span>
      )}
      {card.orphans.length > 0 && (
        <span className={styles.storageMetaPillOrphaned}>
          {t("storage_summary_orphaned", {
            size: formatBytes(card.orphanedBytes),
          })}
          {" · "}
          {t(
            card.orphans.length === 1
              ? "storage_orphaned_label_singular"
              : "storage_orphaned_label_plural",
            { count: card.orphans.length },
          )}
        </span>
      )}
    </>
  );
}
