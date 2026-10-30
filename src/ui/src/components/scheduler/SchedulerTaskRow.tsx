import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import {
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Hand,
  AlertTriangle,
  ArrowUpRight,
} from "lucide-react";
import {
  type ScheduledTask,
  type ScheduledTaskRun,
  listScheduledTaskRuns,
} from "../../services/tauri";
import {
  type TaskStatus,
  canResume,
  cycleProgress,
  formatAgo,
  formatCountdown,
} from "./schedulerModel";
import styles from "./SchedulerPage.module.css";

const RUN_HISTORY_LIMIT = 10;

export interface TaskRowProps {
  task: ScheduledTask;
  status: TaskStatus;
  now: number;
  workspaceLabel: string;
  /** Target session name, "new session each run", or a short id. */
  targetLabel: string;
  backendLabel: string | null;
  busy: boolean;
  /** Changes whenever the task list reloads, so an open history refetches. */
  refreshKey: unknown;
  sessionName: (workspaceId: string, sessionId: string) => string;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onRun: (task: ScheduledTask) => void;
  onPause: (task: ScheduledTask) => void;
  onResume: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => void;
  t: TFunction<"scheduler">;
}

function formatLocalDateTime(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Human label for a status pill, including the reason for automatic
 *  disables so the row explains itself without expanding. */
export function statusLabel(task: ScheduledTask, status: TaskStatus, t: TFunction<"scheduler">) {
  switch (status) {
    case "running":
      return t("status_running");
    case "active":
      return t("status_active");
    case "paused":
      return t("status_paused");
    case "failing":
      return t("status_failing", { n: task.failure_count });
    case "done":
      return t("status_done");
    case "disabled":
      switch (task.disabled_reason) {
        case "workspace_unavailable":
        case "workspace_archived":
          return t("status_disabled_workspace");
        case "terminal_dispatch_error":
          return t("status_disabled_error");
        default:
          return t("status_disabled");
      }
  }
}

export function SchedulerTaskRow({
  task,
  status,
  now,
  workspaceLabel,
  targetLabel,
  backendLabel,
  busy,
  refreshKey,
  sessionName,
  onOpenSession,
  onRun,
  onPause,
  onResume,
  onDelete,
  t,
}: TaskRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [runs, setRuns] = useState<ScheduledTaskRun[] | null>(null);

  // Two-step delete: the first click arms, a second within 3s confirms.
  // Avoids a blocking window.confirm in the webview.
  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    listScheduledTaskRuns(task.id, RUN_HISTORY_LIMIT)
      .then((list) => {
        if (!cancelled) setRuns(list);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, task.id, refreshKey]);

  const isWakeup = task.kind === "wakeup";
  const title = task.name || task.prompt.split("\n")[0];
  const schedule = isWakeup
    ? formatLocalDateTime(task.fire_at) ?? t("fire_at_unknown")
    : task.human_schedule || task.cron_expr || t("schedule_unknown");
  const progress = cycleProgress(task, now);
  const lastRun = task.last_run;
  const targetSessionId = task.create_new_session ? null : task.chat_session_id;

  return (
    <li className={`${styles.row} ${styles[`row_${status}`] ?? ""}`}>
      <div className={styles.rowHead}>
        <button
          type="button"
          className={styles.expandBtn}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? t("collapse") : t("expand")}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <span
          className={`${styles.statusPill} ${styles[`pill_${status}`]}`}
          title={task.last_error ?? undefined}
        >
          <span className={styles.statusDot} />
          {statusLabel(task, status, t)}
        </span>
        <span className={styles.rowTitle} title={task.prompt}>
          {title}
        </span>
        {backendLabel && (
          <span className={styles.backendBadge} title={t("backend_badge_title")}>
            {backendLabel}
            {task.model ? ` · ${task.model}` : ""}
          </span>
        )}
        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => onRun(task)}
            disabled={busy}
            title={t("run_now")}
            aria-label={t("run_now")}
          >
            <Play size={13} />
          </button>
          {task.enabled ? (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => onPause(task)}
              disabled={busy}
              title={t("pause")}
              aria-label={t("pause")}
            >
              <Pause size={13} />
            </button>
          ) : canResume(task) ? (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => onResume(task)}
              disabled={busy}
              title={t("resume")}
              aria-label={t("resume")}
            >
              <RotateCcw size={13} />
            </button>
          ) : null}
          <button
            type="button"
            className={confirmDelete ? styles.dangerConfirmBtn : styles.iconBtnDanger}
            onClick={() => {
              if (confirmDelete) {
                setConfirmDelete(false);
                onDelete(task);
              } else {
                setConfirmDelete(true);
              }
            }}
            disabled={busy}
            title={confirmDelete ? t("delete_confirm") : t("delete")}
            aria-label={confirmDelete ? t("delete_confirm") : t("delete")}
          >
            <Trash2 size={13} />
            {confirmDelete && <span>{t("delete_confirm")}</span>}
          </button>
        </div>
      </div>

      <div className={styles.rowMeta}>
        <span className={styles.metaSchedule}>{schedule}</span>
        {!isWakeup && task.cron_expr && <code className={styles.cron}>{task.cron_expr}</code>}
        {!isWakeup && !task.recurring && <span>{t("mode_one_shot")}</span>}
        <span className={styles.metaSep}>·</span>
        <span className={styles.metaTarget}>
          {workspaceLabel}
          <span className={styles.metaSep}>›</span>
          {targetSessionId ? (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => onOpenSession(task.workspace_id, targetSessionId)}
              title={t("open_session")}
            >
              {targetLabel}
            </button>
          ) : (
            <span className={styles.newSession}>{targetLabel}</span>
          )}
        </span>
      </div>

      <div className={styles.rowTiming}>
        {progress !== null && (
          <span className={styles.progressTrack} aria-hidden>
            <span className={styles.progressFill} style={{ width: `${progress * 100}%` }} />
          </span>
        )}
        <span className={styles.timingText}>
          {task.next_fire_at
            ? t("next_in", { time: formatCountdown(task.next_fire_at, now) })
            : t("not_scheduled")}
        </span>
        {lastRun ? (
          <span className={styles.timingText}>
            <span className={styles.metaSep}>·</span>
            {lastRun.error ? (
              <AlertTriangle size={11} className={styles.runErrorIcon} />
            ) : null}
            {t("last_run_ago", { time: formatAgo(lastRun.fired_at, now) })}
            {lastRun.chat_session_id && (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => onOpenSession(task.workspace_id, lastRun.chat_session_id!)}
                title={t("open_last_run")}
              >
                <ArrowUpRight size={11} />
                {t("open_last_run")}
              </button>
            )}
          </span>
        ) : task.last_fired_at ? (
          <span className={styles.timingText}>
            <span className={styles.metaSep}>·</span>
            {t("last_run_ago", { time: formatAgo(task.last_fired_at, now) })}
          </span>
        ) : null}
      </div>

      {(status === "failing" || status === "disabled") && task.last_error && (
        <div className={styles.rowError}>
          <AlertTriangle size={12} />
          <span>{task.last_error}</span>
        </div>
      )}

      {expanded && (
        <div className={styles.rowDetail}>
          <div className={styles.detailLabel}>{t("prompt_label")}</div>
          <pre className={styles.detailPrompt}>{task.prompt}</pre>
          {task.reason && (
            <>
              <div className={styles.detailLabel}>{t("reason_label")}</div>
              <div className={styles.detailText}>{task.reason}</div>
            </>
          )}
          <div className={styles.detailLabel}>{t("history_heading")}</div>
          {runs === null ? (
            <div className={styles.detailText}>{t("loading")}</div>
          ) : runs.length === 0 ? (
            <div className={styles.detailText}>{t("history_empty")}</div>
          ) : (
            <ul className={styles.runList}>
              {runs.map((run) => (
                <RunItem
                  key={run.id}
                  run={run}
                  workspaceId={task.workspace_id}
                  now={now}
                  sessionName={sessionName}
                  onOpenSession={onOpenSession}
                  t={t}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function RunItem({
  run,
  workspaceId,
  now,
  title,
  sessionName,
  onOpenSession,
  t,
}: {
  run: ScheduledTaskRun;
  workspaceId: string;
  now: number;
  /** Task title, shown in the cross-task activity feed. */
  title?: string;
  sessionName: (workspaceId: string, sessionId: string) => string;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  t: TFunction<"scheduler">;
}) {
  const sessionId = run.chat_session_id;
  return (
    <li className={styles.runItem}>
      <span
        className={run.error ? styles.runDotError : styles.runDotOk}
        aria-label={run.error ? t("run_failed") : t("run_ok")}
      />
      <span className={styles.runTime} title={new Date(run.fired_at).toLocaleString()}>
        {t("ago", { time: formatAgo(run.fired_at, now) })}
      </span>
      {run.source === "manual" && (
        <span className={styles.runSource} title={t("run_source_manual")}>
          <Hand size={11} />
        </span>
      )}
      {title && <span className={styles.runTitle}>{title}</span>}
      {sessionId && workspaceId && (
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => onOpenSession(workspaceId, sessionId)}
          title={t("open_session")}
        >
          {sessionName(workspaceId, sessionId)}
        </button>
      )}
      {run.error && <span className={styles.runError}>{run.error}</span>}
    </li>
  );
}
