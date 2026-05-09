import { Pencil } from "lucide-react";
import { relativizePath } from "../../hooks/toolSummary";
import { HighlightedPlainText } from "./HighlightedPlainText";
import type { EditSummary } from "./editActivitySummary";
import styles from "./ChatPanel.module.css";

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
}: {
  summary: EditSummary;
  searchQuery: string;
  worktreePath?: string | null;
}) {
  return (
    <div className={styles.turnEditSummary}>
      <div className={styles.turnEditSummaryHeader}>
        <span className={styles.turnEditSummaryTitle}>
          {summary.files.length} file{summary.files.length !== 1 ? "s" : ""} changed
        </span>
        <ChangeStats added={summary.added} removed={summary.removed} />
      </div>
      <div className={styles.turnEditFileList}>
        {summary.files.map((file) => (
          <div key={file.filePath} className={styles.turnEditFileRow}>
            <span className={styles.turnEditFilePath}>
              <HighlightedPlainText
                text={relativizePath(file.filePath, worktreePath)}
                query={searchQuery}
              />
            </span>
            <ChangeStats added={file.added} removed={file.removed} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ChangeStats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className={styles.changeStats}>
      <span className={styles.changeStatsAdded}>+{added}</span>
      <span className={styles.changeStatsRemoved}>-{removed}</span>
    </span>
  );
}
