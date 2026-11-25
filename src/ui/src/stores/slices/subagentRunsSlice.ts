import type { StateCreator } from "zustand";
import { getSubagentRuns } from "../../services/tauri/subagentRuns";
import { EMPTY_RUNS, subagentSessionKey, type SubagentRun } from "../../types/subagent";
import type { AppState } from "../useAppStore";

export interface SubagentRunsSlice {
  subagentRuns: Record<string, SubagentRun[]>;
  /** Cached Claude checkpoint activities can outlive a remote rollback. Keep
   * their IDs hidden until the corresponding native row exists again. */
  prunedSubagentIds: Record<string, ReadonlySet<string>>;
  mergeSubagentRuns: (connectionId: string | null, runs: SubagentRun[]) => void;
  reloadSubagentRuns: (connectionId: string | null, sessionId: string, invalidate?: boolean) => Promise<void>;
}

function rowKey(run: SubagentRun) {
  return JSON.stringify([run.harness, run.run_id]);
}

function withPrunedClaudeIds(
  current: SubagentRunsSlice["prunedSubagentIds"], key: string, removed: Iterable<SubagentRun>,
): SubagentRunsSlice["prunedSubagentIds"] {
  const ids = new Set(current[key]);
  for (const run of removed) {
    if (run.harness !== "claude") continue;
    ids.add(run.run_id);
    if (run.tool_use_id) ids.add(run.tool_use_id);
  }
  return ids.size === (current[key]?.size ?? 0) ? current : { ...current, [key]: ids };
}

export const createSubagentRunsSlice: StateCreator<AppState, [], [], SubagentRunsSlice> = (set, get) => {
  const requests = new Map<string, symbol>();
  return {
    subagentRuns: {},
    prunedSubagentIds: {},
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
      const before = new Set(get().subagentRuns[key]);
      if (invalidate) {
        set((s) => ({
          subagentRuns: { ...s.subagentRuns, [key]: EMPTY_RUNS },
          prunedSubagentIds: withPrunedClaudeIds(s.prunedSubagentIds, key, before),
        }));
      }
      try {
        const snapshot = await getSubagentRuns(sessionId, connectionId);
        if (requests.get(key) !== token || !Array.isArray(snapshot)) return;
        // Remove rows pruned by a rollback on the host. Preserve any live
        // update that replaced a row while the snapshot was in flight.
        const byId = new Map(snapshot.filter((run) => run.session_id === sessionId).map((run) => [rowKey(run), run]));
        set((s) => {
          const removed: SubagentRun[] = [];
          const next: SubagentRun[] = [];
          for (const cached of s.subagentRuns[key] ?? EMPTY_RUNS) {
            const id = rowKey(cached);
            const row = byId.get(id);
            if (row) {
              byId.delete(id);
              // After a host restart, the snapshot can project "disconnected"
              // at the saved revision. Accept that observation unless a live
              // event replaced this row while the request was in flight.
              const authoritative = row.revision > cached.revision ||
                (row.revision === cached.revision && before.has(cached));
              next.push(authoritative ? row : cached);
            } else if (before.has(cached)) {
              removed.push(cached);
            } else {
              next.push(cached);
            }
          }
          next.push(...byId.values());
          return {
            subagentRuns: { ...s.subagentRuns, [key]: next },
            prunedSubagentIds: withPrunedClaudeIds(s.prunedSubagentIds, key, removed),
          };
        });
      } catch (err) {
        // Older paired hosts still render Agent activities from checkpoints.
        console.debug("Subagent run history unavailable", err);
      } finally {
        if (requests.get(key) === token) requests.delete(key);
      }
    },
  };
};
