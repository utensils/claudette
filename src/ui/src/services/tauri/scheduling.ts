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
