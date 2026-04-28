import { memo } from "react";
import { useTaskTracker } from "../../hooks/useTaskTracker";
import type { TrackedTask, TaskStatus } from "../../hooks/useTaskTracker";
import styles from "./TaskList.module.css";

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "◐";
    case "completed":
      return "●";
    case "blocked":
      return "◌";
    case "cancelled":
      return "✕";
  }
}

function statusColor(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return "var(--text-dim)";
    case "in_progress":
      return "var(--accent-dim)";
    case "completed":
      return "var(--diff-added-text)";
    case "blocked":
      return "var(--tool-task)";
    case "cancelled":
      return "var(--text-dim)";
  }
}

function TaskItem({ task }: { task: TrackedTask }) {
  const isCompleted = task.status === "completed";
  const isCancelled = task.status === "cancelled";

  return (
    <div className={styles.task}>
      <span
        className={styles.statusIcon}
        style={{ color: statusColor(task.status) }}
        role="img"
        aria-label={task.status.replace(/_/g, " ")}
      >
        {statusIcon(task.status)}
      </span>
      <span
        className={`${styles.description} ${isCompleted || isCancelled ? styles.completedDescription : ""}`}
      >
        {task.description || `Task #${task.id}`}
      </span>
      {task.priority === "high" && (
        <span className={`${styles.priorityBadge} ${styles.priorityHigh}`}>
          !
        </span>
      )}
      {task.priority === "low" && (
        <span className={`${styles.priorityBadge} ${styles.priorityLow}`}>
          low
        </span>
      )}
    </div>
  );
}

export const TaskList = memo(function TaskList({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const { tasks } = useTaskTracker(sessionId);

  if (tasks.length === 0) {
    return (
      <div className={styles.list}>
        <div className={styles.empty}>No tasks</div>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      {tasks.map((task) => (
        <TaskItem key={`${task.source}-${task.id}`} task={task} />
      ))}
    </div>
  );
});
