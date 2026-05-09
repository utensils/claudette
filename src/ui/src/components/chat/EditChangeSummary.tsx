import { useState } from "react";
import { ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { relativizePath } from "../../hooks/toolSummary";
import { HighlightedPlainText } from "./HighlightedPlainText";
import type { EditFileStat, EditPreviewLine, EditSummary } from "./editActivitySummary";
import styles from "./ChatPanel.module.css";

type PreviewState =
  | { status: "idle"; lines: EditPreviewLine[] }
  | { status: "loading"; lines: EditPreviewLine[] }
  | { status: "ready"; lines: EditPreviewLine[] }
  | { status: "error"; lines: EditPreviewLine[] };

export function InlineEditSummary({
  summary,
  searchQuery,
  worktreePath,
}: {
  summary: EditSummary;
  searchQuery: string;
  worktreePath?: string | null;
}) {
  const file = summary.files[0];
  if (!file) return null;
  return (
    <span className={styles.inlineEditSummary}>
      <Pencil size={12} aria-hidden="true" className={styles.inlineEditIcon} />
      <span className={styles.inlineEditVerb}>Editing</span>
      <span className={styles.inlineEditPath}>
        <HighlightedPlainText
          text={relativizePath(file.filePath, worktreePath)}
          query={searchQuery}
        />
      </span>
      <ChangeStats added={summary.added} removed={summary.removed} />
    </span>
  );
}

export function TurnEditSummaryCard({
  summary,
  searchQuery,
  worktreePath,
  onLoadPreview,
}: {
  summary: EditSummary;
  searchQuery: string;
  worktreePath?: string | null;
  onLoadPreview?: (filePath: string) => Promise<EditPreviewLine[]>;
}) {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [previewByFile, setPreviewByFile] = useState<Record<string, PreviewState>>({});

  const toggleFile = (file: EditFileStat) => {
    setExpandedFile((current) => (current === file.filePath ? null : file.filePath));
    if (file.previewLines.length > 0 || !onLoadPreview || previewByFile[file.filePath]) {
      return;
    }
    setPreviewByFile((current) => ({
      ...current,
      [file.filePath]: { status: "loading", lines: [] },
    }));
    onLoadPreview(file.filePath)
      .then((lines) => {
        setPreviewByFile((current) => ({
          ...current,
          [file.filePath]: { status: "ready", lines },
        }));
      })
      .catch(() => {
        setPreviewByFile((current) => ({
          ...current,
          [file.filePath]: { status: "error", lines: [] },
        }));
      });
  };

  return (
    <div className={styles.turnEditSummary}>
      <div className={styles.turnEditSummaryHeader}>
        <span className={styles.turnEditSummaryTitle}>
          {summary.files.length} file{summary.files.length !== 1 ? "s" : ""} changed
        </span>
        <ChangeStats added={summary.added} removed={summary.removed} />
      </div>
      <div className={styles.turnEditFileList}>
        {summary.files.map((file) => {
          const expanded = expandedFile === file.filePath;
          const previewState = previewByFile[file.filePath];
          const previewLines = file.previewLines.length > 0
            ? file.previewLines
            : previewState?.lines ?? [];
          const canExpand = file.previewLines.length > 0 || !!onLoadPreview;
          return (
            <div key={file.filePath} className={styles.turnEditFile}>
              <button
                type="button"
                className={styles.turnEditFileRow}
                aria-expanded={expanded}
                disabled={!canExpand}
                onClick={() => toggleFile(file)}
              >
                <span className={styles.turnEditFilePath}>
                  <HighlightedPlainText
                    text={relativizePath(file.filePath, worktreePath)}
                    query={searchQuery}
                  />
                </span>
                <ChangeStats added={file.added} removed={file.removed} />
                {canExpand && (
                  <span className={styles.turnEditFileChevron} aria-hidden="true">
                    {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </span>
                )}
              </button>
              {expanded && (
                <InlineDiffPreview
                  lines={previewLines}
                  status={previewState?.status ?? "ready"}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChangeStats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className={styles.changeStats}>
      <AnimatedStat value={added} prefix="+" className={styles.changeStatsAdded} />
      <AnimatedStat value={removed} prefix="-" className={styles.changeStatsRemoved} />
    </span>
  );
}

function AnimatedStat({
  value,
  prefix,
  className,
}: {
  value: number;
  prefix: "+" | "-";
  className: string;
}) {
  return (
    <span
      key={`${prefix}${value}`}
      className={`${styles.changeStatsValue} ${
        prefix === "+" ? styles.changeStatsValueUp : styles.changeStatsValueDown
      } ${className}`}
    >
      {prefix}
      {value}
    </span>
  );
}

function InlineDiffPreview({
  lines,
  status,
}: {
  lines: EditPreviewLine[];
  status: PreviewState["status"];
}) {
  if (status === "loading") {
    return <div className={styles.turnEditDiffState}>Loading diff…</div>;
  }
  if (status === "error") {
    return <div className={styles.turnEditDiffState}>Diff unavailable</div>;
  }
  if (lines.length === 0) {
    return <div className={styles.turnEditDiffState}>No preview lines</div>;
  }
  return (
    <div className={styles.turnEditDiffPreview}>
      {lines.map((line, index) => (
        <DiffPreviewLine key={`${index}:${line.type}`} line={line} />
      ))}
    </div>
  );
}

function DiffPreviewLine({ line }: { line: EditPreviewLine }) {
  const lineClass =
    line.type === "added"
      ? styles.turnEditDiffLineAdded
      : line.type === "removed"
        ? styles.turnEditDiffLineRemoved
        : "";
  return (
    <div className={`${styles.turnEditDiffLine} ${lineClass}`}>
      <span className={styles.turnEditDiffLineNumber}>
        {line.oldLineNumber ?? ""}
      </span>
      <span className={styles.turnEditDiffLineNumber}>
        {line.newLineNumber ?? ""}
      </span>
      <span className={styles.turnEditDiffPrefix}>
        {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
      </span>
      <code className={styles.turnEditDiffContent}>{line.content || " "}</code>
    </div>
  );
}
