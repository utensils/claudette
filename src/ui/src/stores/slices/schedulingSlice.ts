import type { StateCreator } from "zustand";
import {
  type ScheduledTask,
  type ScheduledTaskRun,
  listScheduledRoutines,
  listScheduledTaskRuns,
} from "../../services/tauri";
import type { AppState } from "../useAppStore";

/** How many cross-task runs the Loops and Schedules activity feed keeps. */
export const RECENT_RUNS_LIMIT = 30;

export interface SchedulingSlice {
  /** All scheduled tasks (wakeups + cron routines), source-of-truth list
   *  shared with the Settings → Automation panel. */
  scheduledTasks: ScheduledTask[];
  setScheduledTasks: (tasks: ScheduledTask[]) => void;
  /** Newest-first fires across every task, for the activity feed. */
  recentScheduledRuns: ScheduledTaskRun[];
  /** Re-read tasks + recent runs from the backend. Tolerant of transient
   *  errors (leaves the previous lists in place rather than blanking the UI).
   *  Calls made while a load is in flight coalesce into one follow-up load,
   *  so a `scheduled-tasks-changed` event that lands mid-request is never
   *  answered with the pre-change snapshot. */
  loadScheduledTasks: () => Promise<void>;
}

let inflight: Promise<void> | null = null;
let reloadQueued = false;

export const createSchedulingSlice: StateCreator<
  AppState,
  [],
  [],
  SchedulingSlice
> = (set, get) => ({
  scheduledTasks: [],
  setScheduledTasks: (tasks) => set({ scheduledTasks: tasks }),
  recentScheduledRuns: [],
  loadScheduledTasks: () => {
    if (inflight) {
      reloadQueued = true;
      return inflight;
    }
    inflight = Promise.all([
      listScheduledRoutines(),
      listScheduledTaskRuns(undefined, RECENT_RUNS_LIMIT),
    ])
      .then(([tasks, runs]) => {
        get().setScheduledTasks(tasks);
        set({ recentScheduledRuns: runs });
      })
      .catch(() => {
        // Swallow — keep the prior lists visible; the next change event (or
        // manual refresh) retries.
      })
      .finally(() => {
        inflight = null;
        if (reloadQueued) {
          reloadQueued = false;
          void get().loadScheduledTasks();
        }
      });
    return inflight;
  },
});
