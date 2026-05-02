import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { listWorkspaceFiles, type FileEntry } from "../../services/tauri";
import { FileTree } from "./FileTree";
import styles from "./FilesPanel.module.css";

export function FilesPanel() {
  const { t } = useTranslation("chat");
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const openFileTab = useAppStore((s) => s.openFileTab);

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [maxEntries, setMaxEntries] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setEntries([]);
      setTruncated(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listWorkspaceFiles(selectedWorkspaceId)
      .then((result) => {
        if (cancelled) return;
        setEntries(result.entries);
        setTruncated(result.truncated);
        setMaxEntries(result.max_entries);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId]);

  const handleActivateFile = useCallback(
    (path: string) => {
      // With tabs, opening a file is unconditional: either it's already
      // open (we just select it) or it's new (we add the tab). Buffers are
      // preserved across tab switches in the store, so there's no risk of
      // losing unsaved edits on click. The discard-changes prompt now
      // lives on the tab's close button instead.
      if (!selectedWorkspaceId) return;
      openFileTab(selectedWorkspaceId, path);
    },
    [selectedWorkspaceId, openFileTab],
  );

  if (!selectedWorkspaceId) {
    return <div className={styles.empty}>No workspace selected</div>;
  }

  return (
    <div className={styles.panel}>
      {loading ? (
        <div className={styles.empty}>Loading…</div>
      ) : error ? (
        <div className={styles.empty}>Failed to load: {error}</div>
      ) : (
        <>
          {truncated && (
            <div className={styles.truncatedBanner} role="status">
              {t("files_truncated_banner", { max: maxEntries })}
            </div>
          )}
          <FileTree
            workspaceId={selectedWorkspaceId}
            entries={entries}
            onActivateFile={handleActivateFile}
          />
        </>
      )}
    </div>
  );
}
