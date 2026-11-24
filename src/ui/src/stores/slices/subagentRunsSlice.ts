import type { StateCreator } from "zustand";
import { subagentSessionKey, type SubagentRun } from "../../types/subagent";
import type { AppState } from "../useAppStore";

export interface SubagentRunsSlice {
  subagentRuns: Record<string, SubagentRun[]>;
  mergeSubagentRuns: (connectionId: string | null, runs: SubagentRun[]) => void;
}

export const createSubagentRunsSlice: StateCreator<AppState, [], [], SubagentRunsSlice> = (set) => ({
  subagentRuns: {},
  mergeSubagentRuns: (connectionId, runs) => set((state) => {
    const next = { ...state.subagentRuns };
    const changed = new Set<string>();
    for (const run of runs) {
      const key = subagentSessionKey(connectionId, run.session_id);
      const rows = next[key] ?? [];
      const index = rows.findIndex((other) => other.harness === run.harness && other.run_id === run.run_id);
      // A snapshot request may resolve after a newer event. Hosts increment
      // this counter inside the same transaction that writes the run.
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
});
