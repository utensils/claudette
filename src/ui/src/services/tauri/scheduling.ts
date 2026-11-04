import { invoke } from "@tauri-apps/api/core";

export type ScheduledTaskKind = "wakeup" | "cron";

/** One recorded fire of a scheduled task (scheduled or "Run now"). */
export interface ScheduledTaskRun {
  id: string;
  task_id: string;
  /** Session the prompt landed in — a fresh one per fire for new-session
   *  tasks. `null` when the fire failed before a session took it. */
  chat_session_id: string | null;
  source: "scheduled" | "manual";
  fired_at: string;
  /** Dispatch error when the fire didn't start a turn. */
  error: string | null;
}

/** Tauri event emitted whenever any scheduled task changes (created,
 *  deleted, fired, failed, paused/resumed). Payload-less. */
export const SCHEDULED_TASKS_CHANGED_EVENT = "scheduled-tasks-changed";

export interface ScheduledTask {
  id: string;
  /** Target session for reuse-mode tasks; `null` when `create_new_session`
   *  is set (the scheduler makes a fresh session per fire). */
  chat_session_id: string | null;
  workspace_id: string;
  /** When true, each fire creates a brand-new session in `workspace_id`
   *  instead of reusing `chat_session_id`. */
  create_new_session: boolean;
  kind: ScheduledTaskKind;
  name: string | null;
  prompt: string;
  reason: string | null;
  fire_at: string | null;
  cron_expr: string | null;
  recurring: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
  next_fire_at: string | null;
  failure_count: number;
  last_failed_at: string | null;
  last_error: string | null;
  disabled_reason: string | null;
  /** Backend the task was scheduled under. The scheduler forwards this to
   *  `send_chat_message` on fire so a cron created from a Codex chat
   *  runs on the same runtime it was scheduled under. `null` falls back
   *  to the global default backend at fire time. */
  backend_id: string | null;
  /** Model id captured at schedule time. `null` falls back to the
   *  backend's default model at fire time. */
  model: string | null;
  human_schedule: string | null;
  /** Most recent fire, or `null` if the task never fired. */
  last_run: ScheduledTaskRun | null;
}

export function listScheduledRoutines(): Promise<ScheduledTask[]> {
  return invoke("list_scheduled_routines");
}

export function deleteScheduledRoutine(id: string): Promise<{ deleted: number }> {
  return invoke("delete_scheduled_routine", { id });
}

export function runScheduledRoutine(id: string): Promise<{ ok: boolean }> {
  return invoke("run_scheduled_routine", { id });
}

/** Stop a task from firing until it's resumed. */
export function pauseScheduledRoutine(id: string): Promise<ScheduledTask> {
  return invoke("pause_scheduled_routine", { id });
}

/** Re-arm a paused or auto-disabled task (clears its failure streak).
 *  Rejects for a wakeup that already fired. */
export function resumeScheduledRoutine(id: string): Promise<ScheduledTask> {
  return invoke("resume_scheduled_routine", { id });
}

/** Newest-first fire history for one task, or across all tasks. */
export function listScheduledTaskRuns(
  taskId?: string,
  limit?: number,
): Promise<ScheduledTaskRun[]> {
  return invoke("list_scheduled_task_runs", {
    taskId: taskId ?? null,
    limit: limit ?? null,
  });
}

/** Schedule a one-shot wakeup. Either `delaySeconds` or `fireAt` (RFC3339)
 *  must be provided. Target the task either at an existing `sessionId` OR a
 *  workspace with `createNewSession: true` + `workspaceId` (a fresh session is
 *  made when it fires). Pass `backendId` / `model` to pin the runtime the
 *  fired turn will use; both default to the global default backend. */
export function scheduleWakeup(args: {
  sessionId?: string;
  workspaceId?: string;
  createNewSession?: boolean;
  delaySeconds?: number;
  fireAt?: string;
  prompt: string;
  reason?: string;
  backendId?: string;
  model?: string;
}): Promise<ScheduledTask> {
  return invoke("schedule_wakeup", {
    sessionId: args.sessionId ?? null,
    workspaceId: args.workspaceId ?? null,
    createNewSession: args.createNewSession ?? null,
    delaySeconds: args.delaySeconds ?? null,
    fireAt: args.fireAt ?? null,
    prompt: args.prompt,
    reason: args.reason ?? null,
    backendId: args.backendId ?? null,
    model: args.model ?? null,
  });
}

/** Create a recurring cron routine. `cronExpr` is the standard 5-field
 *  cron expression interpreted in local time. See [`scheduleWakeup`] for the
 *  target (session vs. new-session) and `backendId` / `model` semantics. */
export function createCronRoutine(args: {
  sessionId?: string;
  workspaceId?: string;
  createNewSession?: boolean;
  name?: string;
  cronExpr: string;
  prompt: string;
  recurring?: boolean;
  backendId?: string;
  model?: string;
}): Promise<ScheduledTask> {
  return invoke("create_cron_routine", {
    sessionId: args.sessionId ?? null,
    workspaceId: args.workspaceId ?? null,
    createNewSession: args.createNewSession ?? null,
    name: args.name ?? null,
    cronExpr: args.cronExpr,
    prompt: args.prompt,
    recurring: args.recurring ?? true,
    backendId: args.backendId ?? null,
    model: args.model ?? null,
  });
}
