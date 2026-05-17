import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import { RepoIcon } from "../../shared/RepoIcon";
import styles from "../Settings.module.css";

export function StorageSettings() {
  const { t } = useTranslation("settings");
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const openModal = useAppStore((s) => s.openModal);

  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ws of workspaces) {
      if (ws.status !== "Archived") continue;
      counts.set(ws.repository_id, (counts.get(ws.repository_id) ?? 0) + 1);
    }
    return repositories.map((repo) => ({
      repo,
      archivedCount: counts.get(repo.id) ?? 0,
    }));
  }, [repositories, workspaces]);

  const totalArchived = useMemo(
    () => rows.reduce((sum, r) => sum + r.archivedCount, 0),
    [rows],
  );

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("storage_section_title")}</h2>
      <p className={styles.sectionDescription}>
        {t("storage_section_description", { total: totalArchived })}
      </p>

      {rows.length === 0 ? (
        <div className={styles.fieldHint}>{t("storage_no_repos")}</div>
      ) : (
        rows.map(({ repo, archivedCount }) => (
          <div key={repo.id} className={styles.settingRow}>
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
              </div>
              <div className={styles.settingDescription}>
                {t("storage_archived_count", { count: archivedCount })}
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
        ))
      )}
    </div>
  );
}
