import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../stores/useAppStore";
import type { AgentToolCall, ToolActivity } from "../stores/useAppStore";
import {
  loadCompletedTurns,
  listChatSessions,
  sendRemoteCommand,
} from "../services/tauri";
import type { ChatSession } from "../types/chat";
import type { CompletedTurnData } from "../types/checkpoint";
import {
  deriveTaskState,
  finalizeTaskState,
  useTaskTrackerWithHistory,
  type SubagentTaskRun,
  type TaskActivityTurn,
  type TaskRun,
  type TaskTrackerResult,
} from "./useTaskTracker";

export interface SessionTaskHistory {
  session: ChatSession;
  runs: TaskRun[];
}

/// Live task snapshot for a non-active chat session whose agent is
/// still running (typically a TeamCreate teammate in a sibling tab).
/// Surfaced as its own lane between "Current" and "History" so the
/// user can watch teammate progress without focusing the tab.
export interface SiblingSessionTasks {
  session: ChatSession;
  current: TaskTrackerResult;
  subagents: SubagentTaskRun[];
}

export interface WorkspaceTaskHistoryResult {
  current: TaskTrackerResult;
  sessions: SessionTaskHistory[];
  /// Live task lanes for sibling sessions that are currently `Running`.
  /// Excluded from `sessions`/history so live work doesn't show as
  /// "archived" while a teammate is mid-turn.
  siblings: SiblingSessionTasks[];
  /// Per-subagent task buckets sourced from the active session. Each
  /// section is rendered separately in the right-sidebar TaskList so
  /// subagent task lists don't collide with the main agent's.
  subagents: SubagentTaskRun[];
  historyRunCount: number;
  totalBadgeCount: number;
  loading: boolean;
}

const EMPTY_CURRENT: TaskTrackerResult = {
  tasks: [],
  completedCount: 0,
  totalCount: 0,
};

const EMPTY_SUBAGENTS: SubagentTaskRun[] = [];

const EMPTY_SIBLINGS: SiblingSessionTasks[] = [];

const EMPTY_RESULT: WorkspaceTaskHistoryResult = {
  current: EMPTY_CURRENT,
  sessions: [],
  siblings: EMPTY_SIBLINGS,
  subagents: EMPTY_SUBAGENTS,
  historyRunCount: 0,
  totalBadgeCount: 0,
  loading: false,
};
const EMPTY_SESSIONS: ChatSession[] = [];

function parseAgentToolCalls(value: string): AgentToolCall[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as AgentToolCall[]) : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string): string[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

function turnFromData(data: CompletedTurnData): TaskActivityTurn {
  return {
    id: data.checkpoint_id,
    activities: data.activities.map<ToolActivity>((activity) => ({
      toolUseId: activity.tool_use_id,
      toolName: activity.tool_name,
      inputJson: activity.input_json,
      resultText: activity.result_text,
      collapsed: true,
      summary: activity.summary,
      assistantMessageOrdinal: activity.assistant_message_ordinal,
      agentTaskId: activity.agent_task_id,
      agentDescription: activity.agent_description,
      agentLastToolName: activity.agent_last_tool_name,
      agentToolUseCount: activity.agent_tool_use_count,
      agentStatus: activity.agent_status,
      agentToolCalls: parseAgentToolCalls(activity.agent_tool_calls_json),
      agentThinkingBlocks: parseStringArray(activity.agent_thinking_blocks_json),
      agentResultText: activity.agent_result_text,
    })),
  };
}

function mergeSessions(
  fetched: ChatSession[],
  storeSessions: ChatSession[],
): ChatSession[] {
  const byId = new Map<string, ChatSession>();
  for (const session of fetched) byId.set(session.id, session);
  for (const session of storeSessions) byId.set(session.id, session);
  return [...byId.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === "Active" ? -1 : 1;
    return a.sort_order - b.sort_order;
  });
}

async function loadSessionTurns(
  sessionId: string,
  remoteConnectionId: string | null,
): Promise<TaskActivityTurn[]> {
  const data = remoteConnectionId
    ? await sendRemoteCommand(remoteConnectionId, "load_completed_turns", {
        chat_session_id: sessionId,
      })
    : await loadCompletedTurns(sessionId);

  if (!Array.isArray(data)) {
    throw new Error("Remote completed turns response was not an array");
  }

  return data.map(turnFromData);
}

async function loadWorkspaceSessions(
  workspaceId: string,
  remoteConnectionId: string | null,
): Promise<ChatSession[]> {
  const data = remoteConnectionId
    ? await sendRemoteCommand(remoteConnectionId, "list_chat_sessions", {
        workspace_id: workspaceId,
        include_archived: true,
      })
    : await listChatSessions(workspaceId, true);

  if (!Array.isArray(data)) {
    throw new Error("Remote chat sessions response was not an array");
  }

  return data;
}

export function useWorkspaceTaskHistory(
  workspaceId: string | null,
  activeSessionId: string | null,
  historyEnabled = true,
): WorkspaceTaskHistoryResult {
  const workspace = useAppStore((s) =>
    workspaceId ? s.workspaces.find((ws) => ws.id === workspaceId) : null,
  );
  const storeSessions = useAppStore((s) =>
    workspaceId
      ? (s.sessionsByWorkspace[workspaceId] ?? EMPTY_SESSIONS)
      : EMPTY_SESSIONS,
  );
  const activeState = useTaskTrackerWithHistory(activeSessionId);
  const [fetchedSessions, setFetchedSessions] = useState<ChatSession[]>([]);
  const [turnsBySession, setTurnsBySession] = useState<
    Record<string, TaskActivityTurn[]>
  >({});
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingTurns, setLoadingTurns] = useState(false);

  const remoteConnectionId = workspace?.remote_connection_id ?? null;

  // Optimistic-fork OR optimistic-create placeholder selected —
  // backend has no row for this id so `list_chat_sessions` returns
  // "Workspace not found". Skip the load; the hook re-fires against
  // the real workspace id once `commitPendingFork` /
  // `commitPendingCreate` swaps the selection.
  const isPendingPlaceholder = useAppStore((s) =>
    workspaceId
      ? !!s.pendingForks[workspaceId] || !!s.pendingCreates[workspaceId]
      : false,
  );

  useEffect(() => {
    let cancelled = false;
    setFetchedSessions([]);
    setTurnsBySession({});

    if (!workspaceId || !historyEnabled || isPendingPlaceholder) {
      setLoadingSessions(false);
      return;
    }

    setLoadingSessions(true);

    loadWorkspaceSessions(workspaceId, remoteConnectionId)
      .then((sessions) => {
        if (!cancelled) setFetchedSessions(sessions);
      })
      .catch((err) => {
        console.error("Failed to load task history sessions:", err);
      })
      .finally(() => {
        if (!cancelled) setLoadingSessions(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, remoteConnectionId, historyEnabled, isPendingPlaceholder]);

  const sessions = useMemo(
    () => mergeSessions(fetchedSessions, storeSessions),
    [fetchedSessions, storeSessions],
  );

  useEffect(() => {
    let cancelled = false;
    if (!workspaceId || !historyEnabled || sessions.length === 0) {
      setTurnsBySession({});
      setLoadingTurns(false);
      return;
    }

    const sessionsToLoad = sessions.filter(
      (session) => session.id !== activeSessionId,
    );
    if (sessionsToLoad.length === 0) {
      setTurnsBySession({});
      setLoadingTurns(false);
      return;
    }

    setLoadingTurns(true);
    Promise.all(
      sessionsToLoad.map(async (session) => {
        try {
          return [
            session.id,
            await loadSessionTurns(session.id, remoteConnectionId),
          ] as const;
        } catch (err) {
          console.error("Failed to load task history turns:", err);
          return null;
        }
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        setTurnsBySession((prev) => {
          const next = { ...prev };
          for (const entry of entries) {
            if (entry) next[entry[0]] = entry[1];
          }
          return next;
        });
      })
      .finally(() => {
        if (!cancelled) setLoadingTurns(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, sessions, activeSessionId, remoteConnectionId, historyEnabled]);

  if (!workspaceId) return EMPTY_RESULT;

  const histories: SessionTaskHistory[] = [];
  const siblings: SiblingSessionTasks[] = [];
  for (const session of sessions) {
    // For non-active sessions ("session tab closed" semantics, archived
    // sessions, anything except the one currently in focus), graduate
    // leftover `current.tasks` and still-running subagents into the
    // history runs so closed sessions don't silently drop their work.
    // EXCEPTION: if the sibling session's agent is still `Running`
    // (typically a TeamCreate teammate working in another tab), keep
    // its `current` state live so the user can watch teammate progress
    // from the active tab.
    if (session.id === activeSessionId) {
      if (activeState.history.length > 0) {
        histories.push({ session, runs: activeState.history });
      }
      continue;
    }

    const derived = deriveTaskState(turnsBySession[session.id] ?? [], []);
    if (session.agent_status === "Running") {
      if (derived.current.tasks.length > 0 || derived.subagents.length > 0) {
        siblings.push({
          session,
          current: derived.current,
          subagents: derived.subagents,
        });
      }
      // Already-archived runs from this session still surface as
      // history even while it's live (e.g. an older TodoWrite
      // replacement still has past runs to display).
      if (derived.history.length > 0) {
        histories.push({ session, runs: derived.history });
      }
      continue;
    }

    const state = finalizeTaskState(derived);
    if (state.history.length > 0) {
      histories.push({ session, runs: state.history });
    }
  }

  const historyRunCount = histories.reduce(
    (sum, session) => sum + session.runs.length,
    0,
  );

  // Total badge is the count of every task the right-sidebar would
  // surface: main current + subagent buckets + every task across every
  // archived history run. Earlier versions added `historyRunCount` here,
  // which silently mixed task counts with run counts (a single archived
  // run with 8 tasks contributed 1 instead of 8). Subagent counts were
  // also missing originally, causing the badge to undercount whenever an
  // Agent activity carries its own task list (Claude Code's agent-teams
  // flow).
  const subagentTaskCount = activeState.subagents.reduce(
    (sum, run) => sum + run.totalCount,
    0,
  );
  const historyTaskCount = histories.reduce(
    (sum, session) =>
      sum + session.runs.reduce((s, run) => s + run.totalCount, 0),
    0,
  );
  const siblingTaskCount = siblings.reduce(
    (sum, sibling) =>
      sum +
      sibling.current.totalCount +
      sibling.subagents.reduce((s, sub) => s + sub.totalCount, 0),
    0,
  );
  const totalBadgeCount =
    activeState.current.totalCount +
    subagentTaskCount +
    siblingTaskCount +
    historyTaskCount;

  return {
    current: activeState.current,
    sessions: histories,
    siblings,
    subagents: activeState.subagents,
    historyRunCount,
    totalBadgeCount,
    loading: loadingSessions || loadingTurns,
  };
}
