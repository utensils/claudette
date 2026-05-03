import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlignJustify, Check, Columns2, Copy, Eye, GitCompare } from "lucide-react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "../../stores/useAppStore";
import { loadCommitFileDiff, loadFileDiff, readWorkspaceFile } from "../../services/tauri";
import { WorkspacePanelHeader } from "../shared/WorkspacePanelHeader";
import { PaneToolbar } from "../shared/PaneToolbar";
import { SegmentedControl } from "../shared/SegmentedControl";
import { IconButton } from "../shared/IconButton";
import { SessionTabs } from "../chat/SessionTabs";
import { MessageMarkdown } from "../chat/MessageMarkdown";
import { getCachedHighlight, highlightCode } from "../../utils/highlight";
import { languageForFile } from "../../utils/languageForFile";
import { bootstrapGrammarRegistry } from "../../utils/grammarRegistry";
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
  // Cache version: bumped when DiffViewer's prewarm completes so
  // memoized line renderings re-evaluate `getCachedHighlight` and
  // pick up the now-cached HTML. Without this, `memo` would skip the
  // re-render and lines would stay plain even though the cache is
  // hot.
  cacheVersion: _cacheVersion,
}: {
  content: string;
  language: string | null;
  cacheVersion: number;
}) {
  const html = language ? getCachedHighlight(content, language) : null;
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
  const { t } = useTranslation("chat");
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const diffSelectedLayer = useAppStore((s) => s.diffSelectedLayer);
  const diffContent = useAppStore((s) => s.diffContent);
  const diffMergeBase = useAppStore((s) => s.diffMergeBase);
  const diffViewMode = useAppStore((s) => s.diffViewMode);
  const setDiffViewMode = useAppStore((s) => s.setDiffViewMode);
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
  const diffSelectedCommitHash = useAppStore((s) => s.diffSelectedCommitHash);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const isMarkdown = !!diffSelectedFile && MARKDOWN_EXT.test(diffSelectedFile);
  const showRendered = isMarkdown && diffPreviewMode === "rendered";

  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copyResetRef = useRef<number | null>(null);

  useEffect(() => {
    setCopyState("idle");
    if (copyResetRef.current !== null) {
      window.clearTimeout(copyResetRef.current);
      copyResetRef.current = null;
    }
  }, [diffSelectedFile]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    };
  }, []);

  const handleCopyContents = useCallback(async () => {
    if (!selectedWorkspaceId || !diffSelectedFile) return;
    // Capture path at invocation; if the user switches files before the
    // async work resolves we bail so the copy result doesn't apply to a
    // different file's button (would show a stale checkmark).
    const requestedFile = diffSelectedFile;
    let nextState: "copied" | "error";
    try {
      const file = await readWorkspaceFile(selectedWorkspaceId, requestedFile);
      // The backend caps reads at 100 KB. Copying a truncated prefix would
      // silently mislead the user — treat truncation as a copy failure.
      if (file.is_binary || file.content === null || file.truncated) {
        nextState = "error";
      } else {
        await clipboardWriteText(file.content);
        nextState = "copied";
      }
    } catch (e) {
      console.error("Copy file contents failed:", e);
      nextState = "error";
    }
    if (useAppStore.getState().diffSelectedFile !== requestedFile) return;
    setCopyState(nextState);
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => setCopyState("idle"), 1500);
  }, [selectedWorkspaceId, diffSelectedFile]);

  // Monotonic version token: each new fetch bumps it so a stale in-flight
  // response (e.g. user already switched diff tabs) gets dropped instead of
  // overwriting the now-active file's content.
  const loadVersionRef = useRef(0);
  const previewVersionRef = useRef(0);

  useEffect(() => {
    if (!diffSelectedFile || !ws?.worktree_path) return;
    if (!diffSelectedCommitHash && !diffMergeBase) return;
    const version = ++loadVersionRef.current;
    setDiffLoading(true);
    const load = diffSelectedCommitHash
      ? loadCommitFileDiff(ws.worktree_path, diffSelectedCommitHash, diffSelectedFile)
      : loadFileDiff(ws.worktree_path, diffMergeBase!, diffSelectedFile, diffSelectedLayer ?? undefined);
    load
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
    diffSelectedCommitHash,
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

  // Bumps once per diff after the per-line Shiki cache is warmed.
  // LineContent reads `getCachedHighlight` (sync); the bump
  // invalidates its `memo` so it re-evaluates the cache lookup.
  const [cacheVersion, setCacheVersion] = useState(0);

  // Plugin grammars register at startup but the `languageForFile`
  // result depends on the plugin registry being loaded. Re-evaluate
  // when `grammarsReady` flips so a `.foo` diff that opens during
  // boot gets the right language id once registration completes.
  const [grammarsReady, setGrammarsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void bootstrapGrammarRegistry().then(() => {
      if (!cancelled) setGrammarsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const language = useMemo(
    () => languageForFile(diffSelectedFile),
    // grammarsReady is read at call time but not in deps for `useMemo`;
    // including it forces re-resolution once plugin grammars finish
    // registering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diffSelectedFile, grammarsReady],
  );

  // Prewarm the Shiki line cache for every distinct line in the diff.
  // Each `highlightCode` call is async but populates the LRU in
  // `utils/highlight.ts`; once all promises resolve we bump
  // `cacheVersion` so memoized `LineContent` instances re-render and
  // hit the cache synchronously.
  //
  // Per-line highlighting is structurally the same trade-off the diff
  // viewer made under highlight.js: multi-line constructs (block
  // comments, template literals) tokenize per-line and may render
  // imperfectly inside a hunk. Acceptable cost for a sync per-line
  // render path.
  useEffect(() => {
    // No reset of `cacheVersion` here — when the file switches before
    // the new file's prewarm completes, LineContent reads its cache
    // synchronously and gets a miss for the new lines, falling back
    // to plain text. The next bump (when prewarm resolves) re-tokenizes.
    // Also avoids the `react-hooks/refs` lint warning about synchronous
    // setState in effects.
    if (!diffContent || !language) return;
    let cancelled = false;
    const distinct = new Set<string>();
    for (const hunk of diffContent.hunks) {
      for (const line of hunk.lines) distinct.add(line.content);
    }
    void Promise.all(
      Array.from(distinct).map((line) => highlightCode(line, language)),
    ).then(() => {
      if (!cancelled) setCacheVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [diffContent, language]);

  return (
    <div className={styles.viewer}>
      <WorkspacePanelHeader />
      {selectedWorkspaceId && <SessionTabs workspaceId={selectedWorkspaceId} />}
      {diffSelectedFile && (
        <PaneToolbar
          path={diffSelectedFile}
          actions={
            <>
              <IconButton
                onClick={handleCopyContents}
                tooltip={
                  copyState === "copied"
                    ? t("diff_tooltip_copied")
                    : copyState === "error"
                      ? t("diff_tooltip_copy_failed")
                      : t("diff_tooltip_copy_contents")
                }
                aria-live="polite"
              >
                {copyState === "copied" ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
              </IconButton>
              {isMarkdown && (
                <SegmentedControl
                  ariaLabel={t("diff_markdown_view_mode_aria")}
                  value={diffPreviewMode}
                  onChange={setDiffPreviewMode}
                  options={[
                    {
                      value: "diff",
                      icon: <GitCompare size={14} aria-hidden="true" />,
                      tooltip: t("diff_tooltip_diff_view"),
                    },
                    {
                      value: "rendered",
                      icon: <Eye size={14} aria-hidden="true" />,
                      tooltip: t("diff_tooltip_preview"),
                    },
                  ]}
                />
              )}
              <SegmentedControl
                ariaLabel={t("diff_view_mode_aria")}
                value={diffViewMode}
                onChange={setDiffViewMode}
                options={[
                  {
                    value: "Unified",
                    icon: <AlignJustify size={14} aria-hidden="true" />,
                    tooltip: t("diff_tooltip_unified_view"),
                  },
                  {
                    value: "SideBySide",
                    icon: <Columns2 size={14} aria-hidden="true" />,
                    tooltip: t("diff_tooltip_split_view"),
                  },
                ]}
              />
            </>
          }
        />
      )}
      <div className={styles.content}>
        {showRendered ? (
          diffPreviewLoading ? (
            <div className={styles.center}>{t("diff_preview_loading")}</div>
          ) : diffPreviewError ? (
            <div className={styles.center}>{t("diff_preview_failed", { error: diffPreviewError })}</div>
          ) : !diffPreviewContent ? (
            <div className={styles.center}>{t("diff_preview_no_content")}</div>
          ) : diffPreviewContent.is_binary || diffPreviewContent.content === null ? (
            <div className={styles.center}>{t("diff_preview_not_text")}</div>
          ) : (
            <div className={styles.previewBody}>
              {diffPreviewContent.truncated && (
                <div className={styles.truncatedBanner}>
                  {t("diff_preview_truncated", { size: formatBytes(diffPreviewContent.size_bytes) })}
                </div>
              )}
              <MessageMarkdown content={diffPreviewContent.content} />
            </div>
          )
        ) : diffLoading ? (
          <div className={styles.center}>{t("diff_loading")}</div>
        ) : !diffContent ? (
          <div className={styles.center}>{t("diff_no_content")}</div>
        ) : diffContent.is_binary ? (
          <div className={styles.center}>{t("diff_binary_changed")}</div>
        ) : diffContent.hunks.length === 0 ? (
          <div className={styles.center}>{t("diff_no_changes")}</div>
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
                    <LineContent
                      content={line.content}
                      language={language}
                      cacheVersion={cacheVersion}
                    />
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
                        cacheVersion={cacheVersion}
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
                        cacheVersion={cacheVersion}
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
