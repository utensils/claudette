import type { StateCreator } from "zustand";
import {
  type ScheduledTask,
  type ScheduledTaskRun,
  listChatSessions,
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

/** Load the session lists of workspaces that own scheduled tasks but haven't
 *  been opened yet. Live `agent_status` updates only reach sessions already in
 *  the store, so without this a fire into an unopened workspace would never
 *  show as running in the scheduler view or the sidebar badge. */
const preloading = new Set<string>();

function preloadTaskSessions(get: () => AppState, tasks: ScheduledTask[]) {
  const loaded = get().sessionsLoadedByWorkspace;
  const pending = new Set(
    tasks
      .map((task) => task.workspace_id)
      .filter((wsId) => !loaded[wsId] && !preloading.has(wsId)),
  );
  for (const wsId of pending) {
    preloading.add(wsId);
    listChatSessions(wsId)
      .then((list) => {
        // Re-check: the workspace may have loaded its own list meanwhile.
        if (!get().sessionsLoadedByWorkspace[wsId]) {
          get().setSessionsForWorkspace(wsId, list);
        }
      })
      .catch(() => {
        // Liveness for this workspace stays unknown; rows still render.
      })
      .finally(() => preloading.delete(wsId));
  }
}

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
      .then(([rawTasks, rawRuns]) => {
        // Normalize: views iterate these unconditionally (the sidebar badge
        // renders at boot), so a missing/odd payload must not crash the app.
        const tasks = Array.isArray(rawTasks) ? rawTasks : [];
        const runs = Array.isArray(rawRuns) ? rawRuns : [];
        get().setScheduledTasks(tasks);
        set({ recentScheduledRuns: runs });
        preloadTaskSessions(get, tasks);
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
