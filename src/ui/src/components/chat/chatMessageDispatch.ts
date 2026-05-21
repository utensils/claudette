import { sendChatMessage, sendRemoteCommand } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import type { PermissionLevel } from "../../stores/useAppStore";
import type { AttachmentInput, ChatMessage } from "../../types/chat";
import { shouldDisable1mContext } from "./chatHelpers";
import {
  buildSendFailureSystemMessage,
  shouldRecordSendFailureInChat,
} from "./chatSendFailure";
import { resolveUltrathinkEffort } from "./ultrathink";

interface DispatchChatMessageArgs {
  sessionId: string;
  content: string;
  mentionedFiles?: string[];
  attachments?: AttachmentInput[];
  messageId?: string;
}

export interface DispatchChatMessageResult {
  workspaceId: string;
  messageId: string;
}

interface MarkChatTurnStartingArgs {
  sessionId: string;
  workspaceId: string;
  messageId: string;
  content: string;
  attachments?: AttachmentInput[];
  startedAt?: number;
}

function resolveSessionWorkspace(sessionId: string) {
  const state = useAppStore.getState();
  for (const [workspaceId, sessions] of Object.entries(state.sessionsByWorkspace)) {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) continue;
    const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return null;
    return { workspaceId, workspace, session };
  }
  return null;
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
  state.updateWorkspace(workspaceId, { agent_status: "Idle" });
  state.updateChatSession(sessionId, { agent_status: "Idle" });
  state.clearPromptStartTime(workspaceId);
}

export async function dispatchChatMessage({
  sessionId,
  content,
  mentionedFiles,
  attachments,
  messageId = crypto.randomUUID(),
}: DispatchChatMessageArgs): Promise<DispatchChatMessageResult | null> {
  const trimmed = content.trim();
  if (!trimmed && !attachments?.length) return null;

  const resolved = resolveSessionWorkspace(sessionId);
  if (!resolved) throw new Error(`Chat session ${sessionId} is not attached to a workspace`);

  const { workspaceId, workspace } = resolved;
  let state = useAppStore.getState();
  const permissionLevel: PermissionLevel = state.permissionLevel[sessionId] ?? "full";

  markChatTurnStarting({
    sessionId,
    workspaceId,
    messageId,
    content: trimmed,
    attachments,
  });

  try {
    state = useAppStore.getState();
    const selectedModel = state.selectedModel[sessionId] || null;
    const selectedProvider = state.selectedModelProvider[sessionId] || null;
    const fastMode = state.fastMode[sessionId] || false;
    const thinkingEnabled = state.thinkingEnabled[sessionId] || false;
    const planMode = state.planMode[sessionId] || false;
    const effort = resolveUltrathinkEffort(trimmed, state.effortLevel[sessionId]);
    const chromeEnabled = state.chromeEnabled[sessionId] || false;
    const disable1mContext = shouldDisable1mContext(selectedModel);

    if (workspace.remote_connection_id) {
      await sendRemoteCommand(workspace.remote_connection_id, "send_chat_message", {
        chat_session_id: sessionId,
        content: trimmed,
        mentioned_files: mentionedFiles,
        permission_level: permissionLevel,
        model: selectedModel,
        backend_id: selectedProvider,
        fast_mode: fastMode,
        thinking_enabled: thinkingEnabled,
        plan_mode: planMode,
        effort: effort ?? null,
        chrome_enabled: chromeEnabled,
        disable_1m_context: disable1mContext,
      });
    } else {
      await sendChatMessage(
        sessionId,
        trimmed,
        mentionedFiles,
        permissionLevel,
        selectedModel ?? undefined,
        fastMode || undefined,
        thinkingEnabled || undefined,
        planMode || undefined,
        effort,
        chromeEnabled || undefined,
        disable1mContext || undefined,
        selectedProvider ?? undefined,
        attachments,
        messageId,
      );
    }
  } catch (e) {
    const errMsg = String(e);
    const current = useAppStore.getState();
    rollbackChatTurnStarting(sessionId, workspaceId);
    if (shouldRecordSendFailureInChat(errMsg)) {
      current.addChatMessage(
        sessionId,
        buildSendFailureSystemMessage({
          error: errMsg,
          workspaceId,
          sessionId,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        }),
        { persisted: false },
      );
    }
    throw e;
  }

  return { workspaceId, messageId };
}
