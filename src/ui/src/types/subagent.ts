/** Full, versioned snapshot emitted by the host after a durable run update. */
export interface SubagentRun {
  session_id: string;
  run_id: string;
  harness: string;
  parent_run_id: string | null;
  assignment: string | null;
  status: string | null;
  summary: string | null;
  tool_use_id: string | null;
  report_kind: string | null;
  report_summary: string | null;
  updated_at: string;
  revision: number;
}

export const EMPTY_RUNS: SubagentRun[] = [];

export function subagentSessionKey(connectionId: string | null, sessionId: string) {
  return JSON.stringify([connectionId, sessionId]);
}
