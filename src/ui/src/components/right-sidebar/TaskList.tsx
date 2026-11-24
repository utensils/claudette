import { memo, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  SubagentTaskRun,
  TaskRun,
  TaskStatus,
  TrackedTask,
} from "../../hooks/useTaskTracker";
import type { WorkspaceTaskHistoryResult } from "../../hooks/useWorkspaceTaskHistory";
import { useActiveTaskScroll } from "../../hooks/useActiveTaskScroll";
import { SubagentDetails, SubagentStatus } from "./SubagentDetails";
import { BoundedScrollPane } from "../shared/BoundedScrollPane";
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

/**
 * Pick the task the Tasks panel should keep in view — the agent's current
 * focus. Preference order:
 *   1. the task that is `in_progress`,
 *   2. otherwise the first `pending` task,
 *   3. otherwise the last task in the list, as a backstop.
 *
 * The backstop is intentionally status-agnostic: when nothing is actively
 * progressing (every task completed, or the list stalled entirely on
 * blocked work) the panel anchors on the end of the list rather than
 * scrolling nowhere.
 */
function findActiveTask(tasks: TrackedTask[]): TrackedTask | null {
  if (tasks.length === 0) return null;
  return (
    tasks.find((t) => t.status === "in_progress") ??
    tasks.find((t) => t.status === "pending") ??
    tasks[tasks.length - 1]
  );
}

function TaskItem({
  task,
  rowRef,
}: {
  task: TrackedTask;
  rowRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const isCompleted = task.status === "completed";
  const isCancelled = task.status === "cancelled";

  return (
    <div className={styles.task} ref={rowRef}>
      <span
        className={styles.statusIcon}
        style={{ color: statusColor(task.status) }}
        role="img"
        aria-label={t(`tasks_status_${task.status}`)}
      >
        {statusIcon(task.status)}
      </span>
      <span
        className={`${styles.description} ${isCompleted || isCancelled ? styles.completedDescription : ""}`}
      >
        {task.description || t("tasks_task_n", { id: task.id })}
      </span>
      {task.priority === "high" && (
        <span className={`${styles.priorityBadge} ${styles.priorityHigh}`}>
          !
        </span>
      )}
      {task.priority === "low" && (
        <span className={`${styles.priorityBadge} ${styles.priorityLow}`}>
          {t("tasks_priority_low")}
        </span>
      )}
    </div>
  );
}

function TaskRows({
  tasks,
  activeTask,
  activeRef,
}: {
  tasks: TrackedTask[];
  /** When set, the matching row receives `activeRef` so the auto-scroll
   *  hook can find it. Only the Current section passes these. */
  activeTask?: TrackedTask | null;
  activeRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      {tasks.map((task) => (
        <TaskItem
          key={`${task.source}-${task.id}-${task.description}`}
          task={task}
          rowRef={activeRef && task === activeTask ? activeRef : undefined}
        />
      ))}
    </>
  );
}

function SubagentSection({ run }: { run: SubagentTaskRun }) {
  const { t } = useTranslation();
  return (
    <section
      className={styles.section}
      aria-label={t("tasks_subagent_aria", { label: run.label })}
    >
      <div className={styles.sectionHeader}>
        <span className={styles.subagentLabel} title={run.tooltip ?? run.label}>
          {run.label}
        </span>
        {run.agent && <SubagentStatus status={run.agent.status} />}
        {run.totalCount > 0 && <span className={styles.sectionMeta}>{run.completedCount}/{run.totalCount}</span>}
      </div>
      {run.agent && <SubagentDetails agent={run.agent} />}
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
  const { t } = useTranslation();
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
        <span
          className={styles.runTitle}
          title={run.tooltip ?? run.label ?? undefined}
        >
          {run.label ?? t("tasks_run_n", { sequence: run.sequence })}
        </span>
        {run.agent && <SubagentStatus status={run.agent.status} />}
        {(!run.agent || run.totalCount > 0) && <span className={styles.runMeta}>{run.completedCount}/{run.totalCount}</span>}
      </button>
      {expanded && (
        <div className={styles.runTasks}>
          {run.agent && <SubagentDetails agent={run.agent} />}
          {run.explanation && (
            <div className={styles.explanation}>{run.explanation}</div>
          )}
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
  const { t } = useTranslation();
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const { current, sessions, siblings, subagents, loading } = taskHistory;

  // The active task drives auto-scroll: when its id changes the hook brings
  // the matching row into view (unless the user has scrolled away).
  const activeTask = findActiveTask(current.tasks);
  const { activeTaskRef, showPill, jumpToActive } = useActiveTaskScroll(
    listRef,
    activeTask?.id ?? null,
  );

  const hasCurrent = current.tasks.length > 0;
  const hasHistory = sessions.length > 0;
  const hasSubagents = subagents.length > 0;
  const hasSiblings = siblings.length > 0;
  const isEmpty = !hasCurrent && !hasHistory && !hasSubagents && !hasSiblings;

  return (
    <div className={styles.container}>
      <BoundedScrollPane ref={listRef} className={styles.list}>
        {isEmpty && (
          <div className={styles.empty}>
            {loading ? t("tasks_loading") : t("tasks_none")}
          </div>
        )}

        {hasCurrent && (
          <section className={styles.section} aria-label={t("tasks_current_aria")}>
            <div className={styles.sectionHeader}>
              <span>{t("tasks_current")}</span>
              <span className={styles.sectionMeta}>
                {current.completedCount}/{current.totalCount}
              </span>
            </div>
            {current.explanation && (
              <div className={styles.explanation}>{current.explanation}</div>
            )}
            <TaskRows
              tasks={current.tasks}
              activeTask={activeTask}
              activeRef={activeTaskRef}
            />
          </section>
        )}

        {hasSubagents &&
          subagents.map((run) => <SubagentSection key={run.id} run={run} />)}

        {hasSiblings &&
          siblings.map((sibling) => (
            <section
              key={`sibling-${sibling.session.id}`}
              className={styles.section}
              aria-label={t("tasks_sibling_aria", { name: sibling.session.name })}
            >
              <div className={styles.sectionHeader}>
                <span
                  className={styles.subagentLabel}
                  title={sibling.session.name}
                >
                  {sibling.session.name}
                  <span className={styles.liveDot} aria-hidden="true" />
                </span>
                <span className={styles.sectionMeta}>
                  {sibling.current.completedCount}/{sibling.current.totalCount}
                </span>
              </div>
              {sibling.current.tasks.length > 0 && (
                <TaskRows tasks={sibling.current.tasks} />
              )}
              {sibling.subagents.map((run) => (
                <SubagentSection key={run.id} run={run} />
              ))}
            </section>
          ))}

        {hasHistory && (
          <section className={styles.section} aria-label={t("tasks_history_aria")}>
            <div className={styles.sectionHeader}>
              <span>{t("tasks_history")}</span>
              <span className={styles.sectionMeta}>
                {taskHistory.historyRunCount}
              </span>
            </div>
            {sessions.map(({ session, runs }) => (
              <div key={session.id} className={styles.sessionGroup}>
                <div className={styles.sessionHeader}>
                  <span className={styles.sessionName}>{session.name}</span>
                  {session.status === "Archived" && (
                    <span className={styles.archivedBadge}>{t("tasks_archived")}</span>
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
      </BoundedScrollPane>

      {showPill && (
        <button
          type="button"
          className={styles.jumpToCurrent}
          onClick={jumpToActive}
          aria-label={t("tasks_jump_aria")}
        >
          <ChevronDown size={14} aria-hidden="true" />
          <span>{t("tasks_jump")}</span>
        </button>
      )}
    </div>
  );
});
