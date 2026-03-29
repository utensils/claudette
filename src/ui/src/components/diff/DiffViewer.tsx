import { useEffect } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { loadFileDiff } from "../../services/tauri";
import styles from "./DiffViewer.module.css";

export function DiffViewer() {
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const diffContent = useAppStore((s) => s.diffContent);
  const diffMergeBase = useAppStore((s) => s.diffMergeBase);
  const diffViewMode = useAppStore((s) => s.diffViewMode);
  const diffLoading = useAppStore((s) => s.diffLoading);
  const setDiffContent = useAppStore((s) => s.setDiffContent);
  const setDiffLoading = useAppStore((s) => s.setDiffLoading);
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile);
  const setDiffError = useAppStore((s) => s.setDiffError);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);

  useEffect(() => {
    if (!diffSelectedFile || !ws?.worktree_path || !diffMergeBase) return;
    setDiffLoading(true);
    loadFileDiff(ws.worktree_path, diffMergeBase, diffSelectedFile)
      .then((content) => {
        setDiffContent(content);
        setDiffLoading(false);
      })
      .catch((e) => {
        setDiffError(String(e));
        setDiffLoading(false);
      });
  }, [
    diffSelectedFile,
    ws?.worktree_path,
    diffMergeBase,
    setDiffContent,
    setDiffLoading,
    setDiffError,
  ]);

  return (
    <div className={styles.viewer}>
      <div className={styles.header}>
        <button
          className={styles.backBtn}
          onClick={() => setDiffSelectedFile(null)}
        >
          ← Back
        </button>
        <span className={styles.fileName}>{diffSelectedFile}</span>
      </div>
      <div className={styles.content}>
        {diffLoading ? (
          <div className={styles.center}>Loading diff...</div>
        ) : !diffContent ? (
          <div className={styles.center}>No diff content</div>
        ) : diffContent.is_binary ? (
          <div className={styles.center}>Binary file changed</div>
        ) : diffContent.hunks.length === 0 ? (
          <div className={styles.center}>No changes</div>
        ) : (
          <div className={styles.diffTable}>
            {diffContent.hunks.map((hunk, hi) => (
              <div key={hi}>
                <div className={styles.hunkHeader}>{hunk.header}</div>
                {hunk.lines.map((line, li) => (
                  <div
                    key={li}
                    className={`${styles.line} ${
                      line.line_type === "Added"
                        ? styles.lineAdded
                        : line.line_type === "Removed"
                          ? styles.lineRemoved
                          : ""
                    }`}
                  >
                    {diffViewMode === "Unified" && (
                      <>
                        <span className={styles.lineNum}>
                          {line.old_line_number ?? ""}
                        </span>
                        <span className={styles.lineNum}>
                          {line.new_line_number ?? ""}
                        </span>
                        <span className={styles.linePrefix}>
                          {line.line_type === "Added"
                            ? "+"
                            : line.line_type === "Removed"
                              ? "-"
                              : " "}
                        </span>
                        <span className={styles.lineContent}>
                          {line.content}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
