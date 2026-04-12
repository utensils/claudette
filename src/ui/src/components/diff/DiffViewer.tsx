import { useEffect, useMemo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { loadFileDiff } from "../../services/tauri";
import { PanelToggles } from "../shared/PanelToggles";
import type { DiffLine } from "../../types/diff";
import styles from "./DiffViewer.module.css";

interface SideBySideRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pair unified diff lines into side-by-side rows.
 *  Consecutive Removed lines are buffered and paired 1:1 with subsequent Added lines.
 *  Context lines flush the buffer and appear on both sides. */
function pairLines(lines: DiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  const removedBuffer: DiffLine[] = [];

  for (const line of lines) {
    if (line.line_type === "Removed") {
      removedBuffer.push(line);
    } else if (line.line_type === "Added") {
      if (removedBuffer.length > 0) {
        rows.push({ left: removedBuffer.shift()!, right: line });
      } else {
        rows.push({ left: null, right: line });
      }
    } else {
      // Context — flush remaining unpaired removes, then show on both sides.
      for (const rem of removedBuffer) {
        rows.push({ left: rem, right: null });
      }
      removedBuffer.length = 0;
      rows.push({ left: line, right: line });
    }
  }

  // Flush trailing unpaired removes.
  for (const rem of removedBuffer) {
    rows.push({ left: rem, right: null });
  }

  return rows;
}

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

  const sideBySideHunks = useMemo(() => {
    if (!diffContent) return [];
    return diffContent.hunks.map((hunk) => ({
      header: hunk.header,
      rows: pairLines(hunk.lines),
    }));
  }, [diffContent]);

  return (
    <div className={styles.viewer}>
      <div className={styles.header} data-tauri-drag-region>
        <div className={styles.headerLeft}>
          <button
            className={styles.backBtn}
            onClick={() => setDiffSelectedFile(null)}
          >
            ← Back
          </button>
          <span className={styles.fileName}>{diffSelectedFile}</span>
        </div>
        <PanelToggles />
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
        ) : diffViewMode === "Unified" ? (
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
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.sideBySide}>
            {sideBySideHunks.map((hunk, hi) => (
              <div key={hi}>
                <div className={styles.hunkHeader}>{hunk.header}</div>
                {hunk.rows.map((row, ri) => (
                  <div key={ri} className={styles.sbsRow}>
                    <div
                      className={`${styles.sbsCell} ${
                        row.left?.line_type === "Removed"
                          ? styles.lineRemoved
                          : row.left === null
                            ? styles.sbsEmpty
                            : ""
                      }`}
                    >
                      <span className={styles.lineNum}>
                        {row.left?.old_line_number ?? ""}
                      </span>
                      <span className={styles.linePrefix}>
                        {row.left?.line_type === "Removed" ? "-" : row.left ? " " : ""}
                      </span>
                      <span className={styles.lineContent}>
                        {row.left?.content ?? ""}
                      </span>
                    </div>
                    <div
                      className={`${styles.sbsCell} ${
                        row.right?.line_type === "Added"
                          ? styles.lineAdded
                          : row.right === null
                            ? styles.sbsEmpty
                            : ""
                      }`}
                    >
                      <span className={styles.lineNum}>
                        {row.right?.new_line_number ?? ""}
                      </span>
                      <span className={styles.linePrefix}>
                        {row.right?.line_type === "Added" ? "+" : row.right ? " " : ""}
                      </span>
                      <span className={styles.lineContent}>
                        {row.right?.content ?? ""}
                      </span>
                    </div>
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
