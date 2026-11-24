import type { StateCreator } from "zustand";
import { getSubagentRuns } from "../../services/tauri/subagentRuns";
import { EMPTY_RUNS, subagentSessionKey, type SubagentRun } from "../../types/subagent";
import type { AppState } from "../useAppStore";

export interface SubagentRunsSlice {
  subagentRuns: Record<string, SubagentRun[]>;
  mergeSubagentRuns: (connectionId: string | null, runs: SubagentRun[]) => void;
  reloadSubagentRuns: (connectionId: string | null, sessionId: string, invalidate?: boolean) => Promise<void>;
}

function rowKey(run: SubagentRun) {
  return JSON.stringify([run.harness, run.run_id]);
}

export const createSubagentRunsSlice: StateCreator<AppState, [], [], SubagentRunsSlice> = (set, get) => {
  const requests = new Map<string, symbol>();
  return {
    subagentRuns: {},
    mergeSubagentRuns: (connectionId, runs) => set((state) => {
      const next = { ...state.subagentRuns };
      const changed = new Set<string>();
      for (const run of runs) {
        const key = subagentSessionKey(connectionId, run.session_id);
        const rows = next[key] ?? [];
        const index = rows.findIndex((other) => other.harness === run.harness && other.run_id === run.run_id);
        if (index !== -1 && rows[index].revision >= run.revision) continue;
        if (!changed.has(key)) {
          next[key] = [...rows];
          changed.add(key);
        }
        if (index === -1) next[key].push(run);
        else next[key][index] = run;
      }
      return changed.size ? { subagentRuns: next } : state;
    }),
    reloadSubagentRuns: async (connectionId, sessionId, invalidate = false) => {
      const key = subagentSessionKey(connectionId, sessionId);
      const token = Symbol();
      requests.set(key, token);
      if (invalidate) set((s) => ({ subagentRuns: { ...s.subagentRuns, [key]: EMPTY_RUNS } }));
      const before = new Set(get().subagentRuns[key]);
      try {
        const snapshot = await getSubagentRuns(sessionId, connectionId);
        if (requests.get(key) !== token || !Array.isArray(snapshot)) return;
        // Remove rows pruned by a rollback on the host. Preserve any live
        // update that replaced a row while the snapshot was in flight.
        const keys = new Set(snapshot.map(rowKey));
        set((s) => {
          const rows = s.subagentRuns[key] ?? EMPTY_RUNS;
          const kept = rows.filter((run) => !before.has(run) || keys.has(rowKey(run)));
          return rows.length === kept.length ? s : { subagentRuns: { ...s.subagentRuns, [key]: kept } };
        });
        get().mergeSubagentRuns(connectionId, snapshot);
      } catch (err) {
        // Older paired hosts still render Agent activities from checkpoints.
        console.debug("Subagent run history unavailable", err);
      } finally {
        if (requests.get(key) === token) requests.delete(key);
      }
    },
  };
};
