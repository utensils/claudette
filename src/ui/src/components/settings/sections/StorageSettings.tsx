import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import { RepoIcon } from "../../shared/RepoIcon";
import { formatBytes } from "../../../utils/formatBytes";
import {
  computeStorageStats,
  scanRogueWorktrees,
  purgeRogueWorktree,
  type RepoStorageStats,
  type RogueWorktree,
} from "../../../services/tauri";
import styles from "../Settings.module.css";

export function StorageSettings() {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const openModal = useAppStore((s) => s.openModal);

  const [stats, setStats] = useState<RepoStorageStats[] | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [rogues, setRogues] = useState<RogueWorktree[] | null>(null);
  const [rogueScanning, setRogueScanning] = useState(true);
  const [rogueError, setRogueError] = useState<string | null>(null);
  const [purgingRogue, setPurgingRogue] = useState<Set<string>>(new Set());
  const [rogueConfirmPath, setRogueConfirmPath] = useState<string | null>(null);

  const refreshStats = useCallback(() => {
    setStatsLoading(true);
    setStatsError(null);
    computeStorageStats()
      .then(setStats)
      .catch((e) => setStatsError(String(e)))
      .finally(() => setStatsLoading(false));
  }, []);

  const refreshRogues = useCallback(() => {
    setRogueScanning(true);
    setRogueError(null);
    scanRogueWorktrees()
      .then(setRogues)
      .catch((e) => setRogueError(String(e)))
      .finally(() => setRogueScanning(false));
  }, []);

  useEffect(() => {
    refreshStats();
    refreshRogues();
  }, [refreshStats, refreshRogues]);

  const archivedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ws of workspaces) {
      if (ws.status !== "Archived") continue;
      if (ws.remote_connection_id) continue;
      counts.set(ws.repository_id, (counts.get(ws.repository_id) ?? 0) + 1);
    }
    return counts;
  }, [workspaces]);

  const rows = useMemo(() => {
    const byRepo = new Map(stats?.map((s) => [s.repository_id, s]) ?? []);
    return repositories
      .filter((r) => !r.remote_connection_id)
      .map((repo) => ({
        repo,
        archivedCount: archivedCounts.get(repo.id) ?? 0,
        stats: byRepo.get(repo.id),
      }));
  }, [repositories, archivedCounts, stats]);

  const totalArchived = useMemo(
    () => rows.reduce((sum, r) => sum + r.archivedCount, 0),
    [rows],
  );

  const toggleRow = (repoId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  const handleRoguePurge = async (path: string) => {
    setPurgingRogue((prev) => new Set(prev).add(path));
    setRogueError(null);
    try {
      await purgeRogueWorktree(path);
      setRogues((prev) => prev?.filter((r) => r.path !== path) ?? null);
      // Re-pull stats so totals stay accurate after a purge.
      refreshStats();
      // Only dismiss the confirm box on success — leaving it open on
      // error keeps the user in the path context they were acting on.
      setRogueConfirmPath(null);
    } catch (e) {
      setRogueError(String(e));
    } finally {
      setPurgingRogue((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  };

  const rogueTotalBytes = useMemo(
    () => rogues?.reduce((sum, r) => sum + (r.size_bytes ?? 0), 0) ?? 0,
    [rogues],
  );

  return (
    <div>
      <div className={styles.storageHeader}>
        <div className={styles.storageHeaderText}>
          <h2 className={styles.sectionTitle}>{t("storage_section_title")}</h2>
          <p className={styles.sectionDescription}>
            {t("storage_section_description", { total: totalArchived })}
          </p>
        </div>
        <button
          className={styles.iconBtn}
          onClick={() => openModal("bulkCleanupArchived", { repoId: null })}
          disabled={totalArchived === 0}
        >
          {t("storage_cleanup_all_button", { count: totalArchived })}
        </button>
      </div>

      {/* Rogue worktrees section — surfaces orphan dirs on disk that
          no workspace row claims. Shown above the per-repo list because
          they're the destructive "wait, where's this disk going?" case. */}
      <div className={styles.storageRogueSection}>
        <div className={styles.storageRogueHeader}>
          <h3 className={styles.subsectionTitle}>
            {t("storage_rogue_title")}
          </h3>
          <button
            className={styles.iconBtn}
            onClick={refreshRogues}
            disabled={rogueScanning}
            title={t("storage_rogue_rescan_tooltip")}
          >
            <RefreshCw size={12} />
            {rogueScanning
              ? t("storage_rogue_scanning")
              : t("storage_rogue_rescan")}
          </button>
        </div>
        {/* Errors are surfaced inside the confirm box when one is open
            (so the user keeps the path context). Show a top-level
            error only when no confirm is open — typically a scan
            failure rather than a purge failure. */}
        {rogueError && !rogueConfirmPath && (
          <div className={styles.storageError}>{rogueError}</div>
        )}
        {!rogueScanning && rogues && rogues.length === 0 && (
          <div className={styles.fieldHint}>{t("storage_rogue_none")}</div>
        )}
        {rogues && rogues.length > 0 && (
          <>
            <p className={styles.sectionDescription}>
              {t("storage_rogue_summary", {
                count: rogues.length,
                size: formatBytes(rogueTotalBytes),
              })}
            </p>
            {rogues.map((r) => {
              const isPurging = purgingRogue.has(r.path);
              return (
                <div key={r.path} className={styles.settingRow}>
                  <div className={styles.settingInfo}>
                    <div className={styles.settingLabel}>
                      {r.inferred_repo_name ?? r.inferred_repo_slug}
                      <span className={styles.storageRogueBadge}>
                        {formatBytes(r.size_bytes)}
                      </span>
                      {!r.inferred_repo_name && (
                        <span className={styles.storageRogueUnknown}>
                          {t("storage_rogue_unknown_repo")}
                        </span>
                      )}
                    </div>
                    <div className={styles.storageRoguePath}>{r.path}</div>
                  </div>
                  <div className={styles.settingControl}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      disabled={isPurging}
                      onClick={() => setRogueConfirmPath(r.path)}
                    >
                      <Trash2 size={12} />
                      {isPurging
                        ? t("storage_rogue_deleting")
                        : t("storage_rogue_delete")}
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
        {rogueConfirmPath && (
          <div className={styles.storageRogueConfirm}>
            <div className={styles.storageRogueConfirmText}>
              {t("storage_rogue_confirm", { path: rogueConfirmPath })}
            </div>
            {rogueError && (
              <div className={styles.storageRogueConfirmError}>
                {rogueError}
              </div>
            )}
            <div className={styles.storageRogueConfirmActions}>
              <button
                className={styles.iconBtn}
                onClick={() => {
                  setRogueConfirmPath(null);
                  setRogueError(null);
                }}
                disabled={purgingRogue.has(rogueConfirmPath)}
              >
                {tCommon("cancel")}
              </button>
              <button
                className={`${styles.iconBtn} ${styles.storageRogueConfirmDelete}`}
                onClick={() => handleRoguePurge(rogueConfirmPath)}
                disabled={purgingRogue.has(rogueConfirmPath)}
              >
                {purgingRogue.has(rogueConfirmPath)
                  ? t("storage_rogue_deleting")
                  : t("storage_rogue_confirm_button")}
              </button>
            </div>
          </div>
        )}
      </div>

      {statsError && <div className={styles.storageError}>{statsError}</div>}

      {rows.length === 0 ? (
        <div className={styles.fieldHint}>{t("storage_no_repos")}</div>
      ) : (
        rows.map(({ repo, archivedCount, stats: repoStats }) => {
          const isExpanded = expanded.has(repo.id);
          const totalBytes = repoStats?.total_bytes ?? 0;
          const activeBytes = repoStats?.active_bytes ?? 0;
          const archivedBytes = repoStats?.archived_bytes ?? 0;
          const wsCount = repoStats?.workspaces.length ?? 0;
          const hasBreakdown = wsCount > 0;
          return (
            <div key={repo.id} className={styles.storageRepoBlock}>
              <div className={styles.settingRow}>
                <button
                  type="button"
                  className={styles.storageRepoChevron}
                  onClick={() => hasBreakdown && toggleRow(repo.id)}
                  disabled={!hasBreakdown}
                  aria-label={t("storage_toggle_breakdown")}
                >
                  {hasBreakdown ? (
                    isExpanded ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )
                  ) : (
                    <span className={styles.storageRepoChevronSpacer} />
                  )}
                </button>
                <div className={styles.settingInfo}>
                  <div className={styles.settingLabel}>
                    {repo.icon && (
                      <RepoIcon
                        icon={repo.icon}
                        size={14}
                        className={styles.repoIcon}
                      />
                    )}
                    {repo.name}
                    {statsLoading && !repoStats ? (
                      <span className={styles.storageBadgeMuted}>
                        {t("storage_loading_size")}
                      </span>
                    ) : (
                      <>
                        <span className={styles.storageBadgeTotal}>
                          {formatBytes(totalBytes)}
                        </span>
                        {repoStats && (
                          <span className={styles.storageBadgeSplit}>
                            {t("storage_split_active", {
                              size: formatBytes(activeBytes),
                            })}
                            {" · "}
                            {t("storage_split_archived", {
                              size: formatBytes(archivedBytes),
                            })}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div className={styles.settingDescription}>
                    {t(
                      archivedCount === 1
                        ? "storage_archived_count_singular"
                        : "storage_archived_count_plural",
                      { count: archivedCount },
                    )}
                  </div>
                </div>
                <div className={styles.settingControl}>
                  <button
                    className={styles.iconBtn}
                    onClick={() =>
                      openModal("bulkCleanupArchived", { repoId: repo.id })
                    }
                    disabled={archivedCount === 0}
                  >
                    {t("storage_cleanup_button")}
                  </button>
                </div>
              </div>
              {isExpanded && repoStats && (
                <div className={styles.storageRepoBreakdown}>
                  {repoStats.workspaces.map((ws) => (
                    <div key={ws.id} className={styles.storageWorkspaceRow}>
                      <div className={styles.storageWorkspaceName}>
                        {ws.name}
                        <span className={styles.storageWorkspaceStatus}>
                          {ws.status === "Archived"
                            ? t("storage_status_archived")
                            : t("storage_status_active")}
                        </span>
                      </div>
                      <div className={styles.storageWorkspaceSize}>
                        {ws.size_bytes != null
                          ? formatBytes(ws.size_bytes)
                          : t("storage_size_missing")}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
