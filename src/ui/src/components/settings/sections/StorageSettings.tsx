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
  getAppSetting,
  scanOrphanedWorktrees,
  setAppSetting,
  type OrphanedWorktree,
  type RepoStorageStats,
  type WorkspaceStorageEntry,
} from "../../../services/tauri";
import { useOrphanBulkPurge } from "./useOrphanBulkPurge";
import styles from "../Settings.module.css";

// Mirrors src/snapshot.rs DEFAULT_CHECKPOINT_RETENTION_COUNT and bounds.
// Out-of-range values are silently clamped by the backend reader; we
// clamp here too so the UI can't display a misleading value.
const DEFAULT_RETENTION = 50;
const MIN_RETENTION = 1;
const MAX_RETENTION = 1000;

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
  // Checkpoint retention: per-workspace cap on how many recent
  // checkpoints retain their file-restore snapshot. Older checkpoints
  // keep their chat history but lose the "restore files" affordance.
  const [retention, setRetention] = useState<number>(DEFAULT_RETENTION);
  const [retentionDraft, setRetentionDraft] = useState<string>(
    String(DEFAULT_RETENTION),
  );
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);

  useEffect(() => {
    getAppSetting("checkpoint_retention_count")
      .then((v) => {
        const n = v ? Number.parseInt(v, 10) : NaN;
        const value = Number.isFinite(n)
          ? Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, n))
          : DEFAULT_RETENTION;
        setRetention(value);
        setRetentionDraft(String(value));
      })
      .catch(() => {});
  }, []);

  const saveRetention = useCallback(async () => {
    const parsed = Number.parseInt(retentionDraft, 10);
    if (!Number.isFinite(parsed)) {
      setRetentionError(t("checkpoint_retention_invalid"));
      return;
    }
    const clamped = Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, parsed));
    setRetentionSaving(true);
    setRetentionError(null);
    try {
      await setAppSetting("checkpoint_retention_count", String(clamped));
      setRetention(clamped);
      setRetentionDraft(String(clamped));
    } catch (e) {
      setRetentionError(String(e));
    } finally {
      setRetentionSaving(false);
    }
  }, [retentionDraft, t]);
  // Bulk confirm: a list of one or more paths the user has staged for
  // deletion. Single-path (per-row trash) and multi-path (per-card
  // "Delete N orphans" or global "Delete all orphans") share the same
  // confirm UI — only the wording changes.
  const [confirmPaths, setConfirmPaths] = useState<string[] | null>(null);
  // Sequential bulk-purge state machine — owns `purging`,
  // `bulkProgress`, and cooperative cancel. The component is the
  // controller (decides what to purge and what to do on completion)
  // while the hook is the engine. See `useOrphanBulkPurge.ts`.
  const {
    purging,
    bulkProgress,
    bulkCancelling,
    start: startBulkPurge,
    cancel: handleBulkOrphanCancel,
  } = useOrphanBulkPurge({
    onPathPurged: (path) => {
      setOrphans((prev) => prev?.filter((r) => r.path !== path) ?? null);
    },
    onComplete: ({ failures, skipped, total }) => {
      // Re-pull stats so totals stay accurate after a partial / full
      // bulk purge.
      computeStorageStats().then(setStats).catch(() => {});

      if (failures.length > 0 || skipped > 0) {
        const parts: string[] = [];
        if (failures.length > 0) {
          const lines = failures.map((f) => `${f.path}: ${f.error}`);
          parts.push(
            `${failures.length}/${total} delete(s) failed:\n${lines.join("\n")}`,
          );
        }
        if (skipped > 0) {
          parts.push(`${skipped} skipped (cancelled).`);
        }
        setError(parts.join("\n\n"));
        // Leave the confirm box open so the user can read the error /
        // skip summary and re-run on the remaining paths.
      } else {
        setConfirmPaths(null);
      }
    },
  });

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
    // Bucket every orphan once: matched-to-real-repo orphans go into
    // `orphansBySlug` keyed by their slug, unmatched go into
    // `unknownBySlug`. Lets the known-cards loop look up its matches in
    // O(1) (`orphansBySlug.get(repo.path_slug)`) instead of re-filtering
    // the full orphans array for every repo (which was O(repos × orphans)).
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
      const matched = orphansBySlug.get(repo.path_slug) ?? [];
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

  /** Stage one or more orphan paths into the confirm overlay, then hand
   *  off to the `useOrphanBulkPurge` engine when the user confirms. */
  const startConfirmedPurge = useCallback(
    (paths: string[]) => {
      setError(null);
      void startBulkPurge(paths);
    },
    [startBulkPurge],
  );

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
          {totalOrphanedCount > 0 && (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.storageDeleteAllOrphansBtn}`}
              onClick={() =>
                setConfirmPaths((orphans ?? []).map((o) => o.path))
              }
              title={t("storage_delete_all_orphans_tooltip")}
            >
              <Trash2 size={12} />
              {t(
                totalOrphanedCount === 1
                  ? "storage_delete_all_orphans_button_singular"
                  : "storage_delete_all_orphans_button_plural",
                { count: totalOrphanedCount },
              )}
            </button>
          )}
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

      {error && !confirmPaths && (
        <div className={styles.storageError}>{error}</div>
      )}

      <h3 className={styles.subsectionTitle}>
        {t("checkpoint_retention_title")}
      </h3>
      <p className={styles.sectionDescription}>
        {t("checkpoint_retention_description", { count: retention })}
      </p>
      <div className={styles.storageHeaderActions}>
        <input
          type="number"
          min={MIN_RETENTION}
          max={MAX_RETENTION}
          step={1}
          value={retentionDraft}
          disabled={retentionSaving}
          onChange={(e) => setRetentionDraft(e.target.value)}
          aria-label={t("checkpoint_retention_title")}
        />
        <button
          type="button"
          className={styles.iconBtn}
          onClick={saveRetention}
          disabled={
            retentionSaving ||
            retentionDraft === String(retention) ||
            !Number.isFinite(Number.parseInt(retentionDraft, 10))
          }
        >
          {retentionSaving
            ? t("checkpoint_retention_saving")
            : tCommon("save")}
        </button>
      </div>
      {retentionError && (
        <div className={styles.storageError}>{retentionError}</div>
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
          onPurgeOrphan={(p) => setConfirmPaths([p])}
          onPurgeAllOrphansForRepo={() =>
            setConfirmPaths(card.orphans.map((o) => o.path))
          }
          onOpenArchivedCleanup={(repoId) =>
            openModal("bulkCleanupArchived", { repoId })
          }
          purging={purging}
        />
      ))}

      {confirmPaths && confirmPaths.length > 0 && (
        <div className={styles.storageOrphanConfirmOverlay}>
          <div className={styles.storageOrphanConfirmCard}>
            <div className={styles.storageOrphanConfirmText}>
              {confirmPaths.length === 1
                ? t("storage_orphaned_confirm", { path: confirmPaths[0] })
                : t("storage_orphaned_bulk_confirm", {
                    count: confirmPaths.length,
                  })}
            </div>
            {confirmPaths.length > 1 && (
              <ul className={styles.storageOrphanConfirmList}>
                {confirmPaths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {bulkProgress && (
              <div className={styles.storageOrphanConfirmProgress}>
                {t("storage_orphaned_bulk_progress", {
                  done: bulkProgress.done,
                  total: bulkProgress.total,
                })}
              </div>
            )}
            {error && (
              <div className={styles.storageOrphanConfirmError}>{error}</div>
            )}
            <div className={styles.storageOrphanConfirmActions}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => {
                  // Two roles on the same button:
                  // - If a purge is in flight, Cancel signals the loop
                  //   to stop after the current item completes. The
                  //   overlay stays open so the user sees the partial
                  //   summary and the remaining paths.
                  // - Otherwise, Cancel just dismisses the overlay.
                  if (bulkProgress !== null) {
                    handleBulkOrphanCancel();
                  } else {
                    setConfirmPaths(null);
                    setError(null);
                  }
                }}
                disabled={bulkCancelling}
              >
                {bulkCancelling
                  ? t("storage_orphaned_cancelling")
                  : tCommon("cancel")}
              </button>
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.storageOrphanConfirmDelete}`}
                onClick={() => startConfirmedPurge(confirmPaths)}
                disabled={bulkProgress !== null}
              >
                <Trash2 size={12} />
                {bulkProgress
                  ? t("storage_orphaned_deleting")
                  : confirmPaths.length === 1
                    ? t("storage_orphaned_confirm_button")
                    : t("storage_orphaned_bulk_confirm_button", {
                        count: confirmPaths.length,
                      })}
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
  onPurgeAllOrphansForRepo: () => void;
  onOpenArchivedCleanup: (repoId: string) => void;
  purging: Set<string>;
}

function RepoCard({
  card,
  expanded,
  onToggle,
  onPurgeOrphan,
  onPurgeAllOrphansForRepo,
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
          {card.orphans.length > 0 && (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.storageCardOrphanBtn}`}
              onClick={onPurgeAllOrphansForRepo}
              title={t("storage_delete_orphans_tooltip")}
            >
              <Trash2 size={12} />
              {t(
                card.orphans.length === 1
                  ? "storage_delete_orphans_button_singular"
                  : "storage_delete_orphans_button_plural",
                { count: card.orphans.length },
              )}
            </button>
          )}
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
