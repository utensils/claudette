import { invoke } from "@tauri-apps/api/core";

export type ScheduledTaskKind = "wakeup" | "cron";

export interface ScheduledTask {
  id: string;
  chat_session_id: string;
  workspace_id: string;
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
  human_schedule: string | null;
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

/** Schedule a one-shot wakeup. Either `delaySeconds` or `fireAt` (RFC3339)
 *  must be provided. */
export function scheduleWakeup(args: {
  sessionId: string;
  delaySeconds?: number;
  fireAt?: string;
  prompt: string;
  reason?: string;
}): Promise<ScheduledTask> {
  return invoke("schedule_wakeup", {
    sessionId: args.sessionId,
    delaySeconds: args.delaySeconds ?? null,
    fireAt: args.fireAt ?? null,
    prompt: args.prompt,
    reason: args.reason ?? null,
  });
}

/** Create a recurring cron routine. `cronExpr` is the standard 5-field
 *  cron expression interpreted in local time. */
export function createCronRoutine(args: {
  sessionId: string;
  name?: string;
  cronExpr: string;
  prompt: string;
  recurring?: boolean;
}): Promise<ScheduledTask> {
  return invoke("create_cron_routine", {
    sessionId: args.sessionId,
    name: args.name ?? null,
    cronExpr: args.cronExpr,
    prompt: args.prompt,
    recurring: args.recurring ?? true,
  });
}
