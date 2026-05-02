import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { listWorkspaceFiles, type FileEntry } from "../../services/tauri";
import { FileTree } from "./FileTree";
import styles from "./FilesPanel.module.css";

export function FilesPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const openFileTab = useAppStore((s) => s.openFileTab);

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listWorkspaceFiles(selectedWorkspaceId)
      .then((result) => {
        if (cancelled) return;
        setEntries(result);
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
        <FileTree
          workspaceId={selectedWorkspaceId}
          entries={entries}
          onActivateFile={handleActivateFile}
        />
      )}
    </div>
  );
}
