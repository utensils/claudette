import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type {
  SubagentTaskRun,
  TaskRun,
  TaskStatus,
  TrackedTask,
} from "../../hooks/useTaskTracker";
import type { WorkspaceTaskHistoryResult } from "../../hooks/useWorkspaceTaskHistory";
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

function TaskRows({ tasks }: { tasks: TrackedTask[] }) {
  return (
    <>
      {tasks.map((task) => (
        <TaskItem key={`${task.source}-${task.id}-${task.description}`} task={task} />
      ))}
    </>
  );
}

function SubagentSection({ run }: { run: SubagentTaskRun }) {
  return (
    <section className={styles.section} aria-label={`Subagent: ${run.label}`}>
      <div className={styles.sectionHeader}>
        <span className={styles.subagentLabel} title={run.label}>
          {run.label}
        </span>
        <span className={styles.sectionMeta}>
          {run.completedCount}/{run.totalCount}
        </span>
      </div>
      <TaskRows tasks={run.tasks} />
    </section>
  );
}

function RunSummary({
  run,
  expanded,
  onToggle,
}: {
  run: TaskRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={styles.run}>
      <button
        type="button"
        className={styles.runHeader}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <ChevronRight
          size={14}
          className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
          aria-hidden="true"
        />
        <span className={styles.runTitle}>Run {run.sequence}</span>
        <span className={styles.runMeta}>
          {run.completedCount}/{run.totalCount}
        </span>
      </button>
      {expanded && (
        <div className={styles.runTasks}>
          <TaskRows tasks={run.tasks} />
        </div>
      )}
    </div>
  );
}

export const TaskList = memo(function TaskList({
  taskHistory,
}: {
  taskHistory: WorkspaceTaskHistoryResult;
}) {
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const { current, sessions, subagents, loading } = taskHistory;
  const hasCurrent = current.tasks.length > 0;
  const hasHistory = sessions.length > 0;
  const hasSubagents = subagents.length > 0;

  if (!hasCurrent && !hasHistory && !hasSubagents) {
    return (
      <div className={styles.list}>
        <div className={styles.empty}>{loading ? "Loading tasks..." : "No tasks"}</div>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      {hasCurrent && (
        <section className={styles.section} aria-label="Current tasks">
          <div className={styles.sectionHeader}>
            <span>Current</span>
            <span className={styles.sectionMeta}>
              {current.completedCount}/{current.totalCount}
            </span>
          </div>
          <TaskRows tasks={current.tasks} />
        </section>
      )}

      {hasSubagents &&
        subagents.map((run) => (
          <SubagentSection key={run.id} run={run} />
        ))}

      {hasHistory && (
        <section className={styles.section} aria-label="Task history">
          <div className={styles.sectionHeader}>
            <span>History</span>
            <span className={styles.sectionMeta}>
              {taskHistory.historyRunCount}
            </span>
          </div>
          {sessions.map(({ session, runs }) => (
            <div key={session.id} className={styles.sessionGroup}>
              <div className={styles.sessionHeader}>
                <span className={styles.sessionName}>{session.name}</span>
                {session.status === "Archived" && (
                  <span className={styles.archivedBadge}>Archived</span>
                )}
              </div>
              {runs.map((run) => {
                const key = `${session.id}:${run.id}`;
                const expanded = expandedRuns[key] === true;
                return (
                  <RunSummary
                    key={key}
                    run={run}
                    expanded={expanded}
                    onToggle={() =>
                      setExpandedRuns((prev) => ({
                        ...prev,
                        [key]: !(prev[key] === true),
                      }))
                    }
                  />
                );
              })}
            </div>
          ))}
        </section>
      )}
    </div>
  );
});
