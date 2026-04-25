import { memo, useEffect, useMemo, useRef } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { loadFileDiff, readWorkspaceFile } from "../../services/tauri";
import { PanelToggles } from "../shared/PanelToggles";
import { SessionTabs } from "../chat/SessionTabs";
import { MessageMarkdown } from "../chat/MessageMarkdown";
import { highlightLine, languageForFile } from "../../utils/syntaxHighlight";
import type { DiffLine } from "../../types/diff";
import styles from "./DiffViewer.module.css";

const MARKDOWN_EXT = /\.(md|markdown)$/i;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SideBySideRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

const LineContent = memo(function LineContent({
  content,
  language,
}: {
  content: string;
  language: string | null;
}) {
  const html = useMemo(() => highlightLine(content, language), [content, language]);
  if (html !== null) {
    return (
      <span
        className={styles.lineContent}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <span className={styles.lineContent}>{content}</span>;
});

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
  const diffSelectedLayer = useAppStore((s) => s.diffSelectedLayer);
  const diffContent = useAppStore((s) => s.diffContent);
  const diffMergeBase = useAppStore((s) => s.diffMergeBase);
  const diffViewMode = useAppStore((s) => s.diffViewMode);
  const diffLoading = useAppStore((s) => s.diffLoading);
  const setDiffContent = useAppStore((s) => s.setDiffContent);
  const setDiffLoading = useAppStore((s) => s.setDiffLoading);
  const setDiffError = useAppStore((s) => s.setDiffError);
  const diffPreviewMode = useAppStore((s) => s.diffPreviewMode);
  const diffPreviewContent = useAppStore((s) => s.diffPreviewContent);
  const diffPreviewLoading = useAppStore((s) => s.diffPreviewLoading);
  const diffPreviewError = useAppStore((s) => s.diffPreviewError);
  const setDiffPreviewMode = useAppStore((s) => s.setDiffPreviewMode);
  const setDiffPreviewContent = useAppStore((s) => s.setDiffPreviewContent);
  const setDiffPreviewLoading = useAppStore((s) => s.setDiffPreviewLoading);
  const setDiffPreviewError = useAppStore((s) => s.setDiffPreviewError);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const isMarkdown = !!diffSelectedFile && MARKDOWN_EXT.test(diffSelectedFile);
  const showRendered = isMarkdown && diffPreviewMode === "rendered";

  // Monotonic version token: each new fetch bumps it so a stale in-flight
  // response (e.g. user already switched diff tabs) gets dropped instead of
  // overwriting the now-active file's content.
  const loadVersionRef = useRef(0);
  const previewVersionRef = useRef(0);

  useEffect(() => {
    if (!diffSelectedFile || !ws?.worktree_path || !diffMergeBase) return;
    const version = ++loadVersionRef.current;
    setDiffLoading(true);
    loadFileDiff(ws.worktree_path, diffMergeBase, diffSelectedFile, diffSelectedLayer ?? undefined)
      .then((content) => {
        if (version !== loadVersionRef.current) return;
        setDiffContent(content);
        setDiffLoading(false);
      })
      .catch((e) => {
        if (version !== loadVersionRef.current) return;
        setDiffError(String(e));
        setDiffLoading(false);
      });
  }, [
    diffSelectedFile,
    diffSelectedLayer,
    ws?.worktree_path,
    diffMergeBase,
    setDiffContent,
    setDiffLoading,
    setDiffError,
  ]);

  // Lazily fetch the working-tree file content when the user toggles into
  // rendered preview. Cached on the store so toggling Diff/Preview repeatedly
  // doesn't refetch; the store resets it on tab switch.
  //
  // Bail when an error is already recorded so a failed fetch isn't retried in
  // an infinite loop — the store clears `diffPreviewError` on tab switch, so
  // moving away and back is the explicit retry signal.
  useEffect(() => {
    if (!showRendered) return;
    if (!selectedWorkspaceId || !diffSelectedFile) return;
    if (diffPreviewContent || diffPreviewLoading || diffPreviewError) return;
    const version = ++previewVersionRef.current;
    setDiffPreviewLoading(true);
    readWorkspaceFile(selectedWorkspaceId, diffSelectedFile)
      .then((content) => {
        if (version !== previewVersionRef.current) return;
        setDiffPreviewContent(content);
        setDiffPreviewLoading(false);
      })
      .catch((e) => {
        if (version !== previewVersionRef.current) return;
        setDiffPreviewError(String(e));
        setDiffPreviewLoading(false);
      });
  }, [
    showRendered,
    selectedWorkspaceId,
    diffSelectedFile,
    diffPreviewContent,
    diffPreviewLoading,
    diffPreviewError,
    setDiffPreviewContent,
    setDiffPreviewLoading,
    setDiffPreviewError,
  ]);

  const sideBySideHunks = useMemo(() => {
    if (!diffContent) return [];
    return diffContent.hunks.map((hunk) => ({
      header: hunk.header,
      rows: pairLines(hunk.lines),
    }));
  }, [diffContent]);

  const language = useMemo(
    () => languageForFile(diffSelectedFile),
    [diffSelectedFile],
  );

  return (
    <div className={styles.viewer}>
      <div className={styles.header} data-tauri-drag-region>
        <div className={styles.headerLeft}>
          <span className={styles.fileName}>{diffSelectedFile}</span>
        </div>
        <div className={styles.headerRight}>
          {isMarkdown && (
            <div
              className={styles.modeToggle}
              role="group"
              aria-label="Markdown view mode"
            >
              <button
                type="button"
                aria-pressed={diffPreviewMode === "diff"}
                className={`${styles.modeToggleButton} ${
                  diffPreviewMode === "diff" ? styles.modeToggleButtonActive : ""
                }`}
                onClick={() => setDiffPreviewMode("diff")}
              >
                Diff
              </button>
              <button
                type="button"
                aria-pressed={diffPreviewMode === "rendered"}
                className={`${styles.modeToggleButton} ${
                  diffPreviewMode === "rendered" ? styles.modeToggleButtonActive : ""
                }`}
                onClick={() => setDiffPreviewMode("rendered")}
              >
                Preview
              </button>
            </div>
          )}
          <PanelToggles />
        </div>
      </div>
      {selectedWorkspaceId && <SessionTabs workspaceId={selectedWorkspaceId} />}
      <div className={styles.content}>
        {showRendered ? (
          diffPreviewLoading ? (
            <div className={styles.center}>Loading preview...</div>
          ) : diffPreviewError ? (
            <div className={styles.center}>Failed to load: {diffPreviewError}</div>
          ) : !diffPreviewContent ? (
            <div className={styles.center}>No content</div>
          ) : diffPreviewContent.is_binary || diffPreviewContent.content === null ? (
            <div className={styles.center}>Cannot render: file is not text</div>
          ) : (
            <div className={styles.previewBody}>
              {diffPreviewContent.truncated && (
                <div className={styles.truncatedBanner}>
                  Preview truncated &mdash; full file is {formatBytes(diffPreviewContent.size_bytes)}
                </div>
              )}
              <MessageMarkdown content={diffPreviewContent.content} />
            </div>
          )
        ) : diffLoading ? (
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
                    <LineContent content={line.content} language={language} />
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
                      <LineContent
                        content={row.left?.content ?? ""}
                        language={language}
                      />
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
                      <LineContent
                        content={row.right?.content ?? ""}
                        language={language}
                      />
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
