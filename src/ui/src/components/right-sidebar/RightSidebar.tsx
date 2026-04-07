import { useEffect } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { loadDiffFiles } from "../../services/tauri";
import styles from "./RightSidebar.module.css";

export function RightSidebar() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const diffFiles = useAppStore((s) => s.diffFiles);
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const diffLoading = useAppStore((s) => s.diffLoading);
  const setDiffFiles = useAppStore((s) => s.setDiffFiles);
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile);
  const setDiffLoading = useAppStore((s) => s.setDiffLoading);
  const setDiffViewMode = useAppStore((s) => s.setDiffViewMode);
  const diffViewMode = useAppStore((s) => s.diffViewMode);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const isRunning = ws?.agent_status === "Running";

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    setDiffLoading(true);
    loadDiffFiles(selectedWorkspaceId)
      .then(({ files, merge_base }) => {
        setDiffFiles(files, merge_base);
        setDiffLoading(false);
      })
      .catch(() => setDiffLoading(false));
  }, [selectedWorkspaceId, setDiffFiles, setDiffLoading]);

  // Refresh diff files when agent stops running (after making changes)
  useEffect(() => {
    if (!selectedWorkspaceId || isRunning) return;

    // Debounce: wait a bit after agent stops to let file writes complete
    const timer = setTimeout(() => {
      loadDiffFiles(selectedWorkspaceId)
        .then(({ files, merge_base }) => {
          setDiffFiles(files, merge_base);
        })
        .catch((e) => console.error("Failed to refresh diff files:", e));
    }, 500);

    return () => clearTimeout(timer);
  }, [isRunning, selectedWorkspaceId, setDiffFiles]);

  const statusLabel = (status: string | { Renamed: { from: string } }) => {
    if (typeof status === "string") {
      return status === "Added"
        ? "A"
        : status === "Modified"
          ? "M"
          : "D";
    }
    return "R";
  };

  const statusColor = (status: string | { Renamed: { from: string } }) => {
    if (typeof status === "string") {
      return status === "Added"
        ? "var(--diff-added-text)"
        : status === "Modified"
          ? "#e6c84d"
          : "var(--diff-removed-text)";
    }
    return "var(--diff-hunk-header)";
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          Changed Files ({diffFiles.length})
        </span>
        <div className={styles.controls}>
          <button
            className={styles.modeBtn}
            onClick={() =>
              setDiffViewMode(
                diffViewMode === "Unified" ? "SideBySide" : "Unified"
              )
            }
            title="Toggle view mode"
          >
            {diffViewMode === "Unified" ? "≡" : "‖"}
          </button>
        </div>
      </div>
      <div className={styles.list}>
        {diffLoading ? (
          <div className={styles.empty}>Loading...</div>
        ) : diffFiles.length === 0 ? (
          <div className={styles.empty}>No changes</div>
        ) : (
          diffFiles.map((file) => (
            <div
              key={file.path}
              className={`${styles.file} ${diffSelectedFile === file.path ? styles.fileSelected : ""}`}
              onClick={() => setDiffSelectedFile(file.path)}
            >
              <span
                className={styles.status}
                style={{ color: statusColor(file.status) }}
              >
                {statusLabel(file.status)}
              </span>
              <span className={styles.path}>{file.path}</span>
              {(file.additions !== undefined || file.deletions !== undefined) && (
                <span className={styles.stats}>
                  {file.additions !== undefined && (
                    <span className={styles.additions}>+{file.additions}</span>
                  )}
                  {file.deletions !== undefined && (
                    <span className={styles.deletions}>-{file.deletions}</span>
                  )}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
