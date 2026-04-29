import styles from "./ChatPanel.module.css";

/** Inline progress bar rendered beneath a turn summary when tasks are present. */
export function TaskProgressBar({
  completedCount,
  totalCount,
}: {
  completedCount: number;
  totalCount: number;
}) {
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const allDone = completedCount === totalCount;

  return (
    <div className={styles.taskProgressBar}>
      <div className={styles.taskProgressTrack}>
        <div
          className={`${styles.taskProgressFill} ${allDone ? styles.taskProgressDone : ""}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={styles.taskProgressLabel}>
        {completedCount}/{totalCount} tasks
      </span>
    </div>
  );
}
