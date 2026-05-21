import { useAppStore, type AppState } from "../../stores/useAppStore";
import type { AttachmentInput, ChatMessage } from "../../types/chat";

interface MarkChatTurnStartingArgs {
  sessionId: string;
  workspaceId: string;
  messageId: string;
  content: string;
  attachments?: AttachmentInput[];
  startedAt?: number;
}

function addPersistedUserMessageToStore(
  sessionId: string,
  workspaceId: string,
  messageId: string,
  content: string,
  attachments?: AttachmentInput[],
) {
  const store = useAppStore.getState();
  const message: ChatMessage = {
    id: messageId,
    workspace_id: workspaceId,
    chat_session_id: sessionId,
    role: "User",
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: new Date().toISOString(),
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
  store.addChatMessage(sessionId, message);

  if (!attachments?.length) return;
  const optimisticAttachments = attachments.map((attachment) => ({
    id: crypto.randomUUID(),
    message_id: messageId,
    filename: attachment.filename,
    media_type: attachment.media_type,
    data_base64: attachment.data_base64,
    text_content: attachment.text_content ?? null,
    width: null,
    height: null,
    size_bytes: Math.ceil(attachment.data_base64.length * 0.75),
  }));
  useAppStore.getState().addChatAttachments(sessionId, optimisticAttachments);
}

function hasRunningActiveSession(state: AppState, workspaceId: string): boolean {
  return (state.sessionsByWorkspace[workspaceId] ?? []).some(
    (session) =>
      session.status === "Active" && session.agent_status === "Running",
  );
}

function hasActiveBackgroundTask(state: AppState, workspaceId: string): boolean {
  const activeSessionIds = new Set(
    (state.sessionsByWorkspace[workspaceId] ?? [])
      .filter((session) => session.status === "Active")
      .map((session) => session.id),
  );
  return Object.entries(state.agentBackgroundTasksBySessionId).some(
    ([sessionId, tabs]) =>
      activeSessionIds.has(sessionId) &&
      tabs.some((tab) => {
        const status = (tab.task_status ?? "").toLowerCase();
        return status === "starting" || status === "running";
      }),
  );
}

export function syncWorkspaceTurnStatus(workspaceId: string) {
  const state = useAppStore.getState();
  state.updateWorkspace(workspaceId, {
    agent_status: hasRunningActiveSession(state, workspaceId)
      ? "Running"
      : hasActiveBackgroundTask(state, workspaceId)
        ? "IdleWithBackground"
        : "Idle",
  });
}

export function clearPromptStartTimeIfWorkspaceIdle(workspaceId: string) {
  const state = useAppStore.getState();
  if (!hasRunningActiveSession(state, workspaceId)) {
    state.clearPromptStartTime(workspaceId);
  }
}

export function markChatTurnStarting({
  sessionId,
  workspaceId,
  messageId,
  content,
  attachments,
  startedAt = Date.now(),
}: MarkChatTurnStartingArgs) {
  const state = useAppStore.getState();
  state.setQueuedMessageAutoDispatchPaused(sessionId, false);
  state.clearAgentQuestion(sessionId);
  state.clearPlanApproval(sessionId);
  state.clearAgentApproval(sessionId);
  state.finishTypewriterDrain(sessionId);
  addPersistedUserMessageToStore(
    sessionId,
    workspaceId,
    messageId,
    content,
    attachments,
  );
  state.updateWorkspace(workspaceId, { agent_status: "Running" });
  state.setPromptStartTime(workspaceId, startedAt);
  state.updateChatSession(sessionId, { agent_status: "Running" });
  state.clearUnreadCompletion(workspaceId);
}

export function rollbackChatTurnStarting(sessionId: string, workspaceId: string) {
  const state = useAppStore.getState();
  state.updateChatSession(sessionId, { agent_status: "Idle" });
  syncWorkspaceTurnStatus(workspaceId);
  clearPromptStartTimeIfWorkspaceIdle(workspaceId);
}
