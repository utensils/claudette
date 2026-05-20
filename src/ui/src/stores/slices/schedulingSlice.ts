import type { StateCreator } from "zustand";
import { type ScheduledTask, listScheduledRoutines } from "../../services/tauri";
import type { AppState } from "../useAppStore";

export interface SchedulingSlice {
  /** All scheduled tasks (wakeups + cron routines), source-of-truth list
   *  shared with the Settings → Automation panel. */
  scheduledTasks: ScheduledTask[];
  setScheduledTasks: (tasks: ScheduledTask[]) => void;
  /** Re-read the list from the backend. Tolerant of transient errors
   *  (leaves the previous list in place rather than blanking the UI). */
  loadScheduledTasks: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const createSchedulingSlice: StateCreator<
  AppState,
  [],
  [],
  SchedulingSlice
> = (set, get) => ({
  scheduledTasks: [],
  setScheduledTasks: (tasks) => set({ scheduledTasks: tasks }),
  loadScheduledTasks: () => {
    if (inflight) return inflight;
    inflight = listScheduledRoutines()
      .then((tasks) => get().setScheduledTasks(tasks))
      .catch(() => {
        // Swallow — keep the prior list visible; the next manual refresh
        // (or store reload) retries.
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
});
