import type { SubagentRun } from "../types/subagent";
import type { SubagentTaskRun, TaskRun, TaskTrackerWithHistory } from "./useTaskTracker";

export interface AgentDetails {
  status: string;
  nativeId?: string;
  summary?: string;
  report?: string;
  reportKind?: string;
  updatedAt?: string;
  parentLabel?: string;
  linkedSessionId?: string;
}

export function isLiveSubagentStatus(status?: string | null): boolean {
  return ["running", "starting", "delegated", "needs_approval"].includes(status?.toLowerCase() ?? "");
}

/** Join native child identity to the launching Claude activity. Keep that
 * activity's checklist, even when the native terminal update arrives after
 * the launch turn was checkpointed. A wait targeting several Codex workers
 * can share a tool call ID, so only Claude activities are joined by tool ID. */
export function mergeSubagentTaskRuns(
  state: TaskTrackerWithHistory, rows: SubagentRun[], prunedIds?: ReadonlySet<string>,
): TaskTrackerWithHistory {
  if (!rows.length && !prunedIds?.size) return state;
  const legacy = new Map<string, TaskRun | SubagentTaskRun>();
  for (const run of state.subagents) legacy.set(run.id, run);
  for (const run of state.history) {
    if (run.agent && run.id.startsWith("subagent-")) legacy.set(run.id.slice("subagent-".length), run);
  }
  for (const run of [...legacy.values()]) {
    if (run.agent?.nativeId) legacy.set(run.agent.nativeId, run);
  }
  const byNativeId = new Map<string, SubagentRun>();
  for (const row of rows) byNativeId.set(JSON.stringify([row.harness, row.run_id]), row);
  const consumed = new Set<TaskRun | SubagentTaskRun>();
  for (const id of prunedIds ?? []) {
    const stale = legacy.get(id);
    if (stale) consumed.add(stale);
  }
  const current: SubagentTaskRun[] = [];
  const finished: TaskRun[] = [];
  let sequence = state.history.reduce((max, run) => Math.max(max, run.sequence), 0);
  for (const row of rows) {
    const previous = row.harness === "claude"
      ? legacy.get(row.tool_use_id ?? row.run_id) ?? legacy.get(row.run_id)
      : undefined;
    if (previous) consumed.add(previous);
    const id = JSON.stringify([row.harness, row.run_id]);
    const status = row.status ?? previous?.agent?.status ?? "unknown";
    const parent = row.parent_run_id ? byNativeId.get(JSON.stringify([row.harness, row.parent_run_id])) : undefined;
    const run: SubagentTaskRun = {
      id,
      label: row.assignment || previous?.label || row.run_id,
      tooltip: row.assignment ?? previous?.tooltip,
      tasks: previous?.tasks ?? [],
      completedCount: previous?.completedCount ?? 0,
      totalCount: previous?.totalCount ?? 0,
      explanation: previous?.explanation,
      status,
      agent: {
        status, nativeId: row.run_id, summary: row.summary ?? previous?.agent?.summary,
        report: row.report_summary ?? undefined, reportKind: row.report_kind ?? undefined,
        linkedSessionId: row.linked_session_id ?? undefined,
        updatedAt: row.updated_at, parentLabel: parent?.assignment ?? row.parent_run_id ?? undefined,
      },
    };
    if (isLiveSubagentStatus(status)) current.push(run);
    else finished.push({ ...run, id: `subagent-${id}`, sequence: ++sequence });
  }
  return {
    ...state,
    subagents: [...state.subagents.filter((run) => !consumed.has(run)), ...current],
    history: [...state.history.filter((run) => !consumed.has(run)), ...finished],
  };
}
