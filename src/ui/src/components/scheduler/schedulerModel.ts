import type { ScheduledTask } from "../../services/tauri";

/** `disabled_reason` the backend writes when the user pauses a task
 *  (mirrors `claudette::scheduling::PAUSED_BY_USER_REASON`). */
export const PAUSED_BY_USER_REASON = "paused";

/**
 * Where a task stands right now, most urgent first:
 * - `running`  — the session it fires into has a turn in progress.
 * - `failing`  — still armed, but recent fires errored.
 * - `disabled` — switched off automatically (archived workspace, terminal
 *                dispatch error); needs the user to resume or delete it.
 * - `paused`   — switched off by the user.
 * - `active`   — armed and healthy.
 * - `done`     — a one-shot that already fired.
 */
export type TaskStatus = "running" | "failing" | "disabled" | "paused" | "active" | "done";

export type StatusFilter = "all" | "active" | "paused" | "attention";

/** The session whose live agent status tells us if this task is running:
 *  its fixed target, or — for new-session tasks — the session the last fire
 *  created. */
export function liveSessionId(task: ScheduledTask): string | null {
  if (task.create_new_session) return task.last_run?.chat_session_id ?? null;
  return task.chat_session_id;
}

export function taskStatus(task: ScheduledTask, isRunning: boolean): TaskStatus {
  if (isRunning) return "running";
  if (!task.enabled) {
    if (task.disabled_reason === PAUSED_BY_USER_REASON) return "paused";
    if (task.disabled_reason) return "disabled";
    return "done";
  }
  if (task.failure_count > 0 && task.last_error) return "failing";
  return "active";
}

export function needsAttention(status: TaskStatus): boolean {
  return status === "failing" || status === "disabled";
}

/** Whether "Resume" applies. A fired wakeup can't be re-armed (the backend
 *  rejects it) — "Run now" is the way to fire it again. */
export function canResume(task: ScheduledTask): boolean {
  if (task.enabled) return false;
  if (task.kind === "wakeup") return task.disabled_reason != null;
  return true;
}

/** Fraction (0..1) of the way from the previous fire (or creation) to the
 *  next one, for the countdown bar. `null` when there's no upcoming fire. */
export function cycleProgress(task: ScheduledTask, now: number): number | null {
  if (!task.enabled || !task.next_fire_at) return null;
  const end = Date.parse(task.next_fire_at);
  const start = Date.parse(task.last_fired_at ?? task.created_at);
  if (Number.isNaN(end) || Number.isNaN(start) || end <= start) return null;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

/** Compact duration until `iso` ("3d 4h", "12m 5s", "0s"). Returns a bare
 *  duration (never a phrase) so callers can wrap it in "next in {{time}}". */
export function formatCountdown(iso: string | null, now: number): string {
  if (!iso) return "—";
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return iso;
  let delta = Math.round((target - now) / 1000);
  if (delta <= 0) return "0s";
  const d = Math.floor(delta / 86400);
  delta -= d * 86400;
  const h = Math.floor(delta / 3600);
  delta -= h * 3600;
  const m = Math.floor(delta / 60);
  const s = delta - m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h && (s || parts.length === 0)) parts.push(`${s}s`);
  return parts.slice(0, 2).join(" ");
}

/** Compact time since `iso` ("5m", "2h 10m", "3d"). */
export function formatAgo(iso: string | null, now: number): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface SchedulerSummary {
  /** Armed recurring cron routines. */
  looping: number;
  /** Armed one-shots (wakeups and non-recurring crons). */
  scheduled: number;
  running: number;
  attention: number;
  paused: number;
  /** The armed task that fires soonest. */
  nextUp: ScheduledTask | null;
}

export function summarize(
  tasks: ScheduledTask[],
  statusOf: (task: ScheduledTask) => TaskStatus,
): SchedulerSummary {
  const summary: SchedulerSummary = {
    looping: 0,
    scheduled: 0,
    running: 0,
    attention: 0,
    paused: 0,
    nextUp: null,
  };
  for (const task of tasks) {
    const status = statusOf(task);
    if (status === "running") summary.running += 1;
    if (needsAttention(status)) summary.attention += 1;
    if (status === "paused") summary.paused += 1;
    if (!task.enabled) continue;
    if (task.kind === "cron" && task.recurring) summary.looping += 1;
    else summary.scheduled += 1;
    if (
      task.next_fire_at &&
      (!summary.nextUp?.next_fire_at || task.next_fire_at < summary.nextUp.next_fire_at)
    ) {
      summary.nextUp = task;
    }
  }
  return summary;
}

export function matchesFilter(
  task: ScheduledTask,
  status: TaskStatus,
  filter: StatusFilter,
  query: string,
  workspaceId: string | null,
): boolean {
  if (workspaceId && task.workspace_id !== workspaceId) return false;
  switch (filter) {
    case "active":
      if (status !== "active" && status !== "running") return false;
      break;
    case "paused":
      if (status !== "paused") return false;
      break;
    case "attention":
      if (!needsAttention(status)) return false;
      break;
    case "all":
      break;
  }
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [task.name, task.prompt, task.reason, task.cron_expr, task.human_schedule]
    .filter((v): v is string => !!v)
    .some((v) => v.toLowerCase().includes(q));
}
