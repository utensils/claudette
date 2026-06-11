import { sendChatMessage, sendRemoteCommand } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import type { PermissionLevel } from "../../stores/useAppStore";
import type { AttachmentInput } from "../../types/chat";
import { shouldDisable1mContext } from "./chatHelpers";
import { isUltracodeSupported } from "./modelCapabilities";
import {
  buildSendFailureSystemMessage,
  shouldRecordSendFailureInChat,
} from "./chatSendFailure";
import {
  markChatTurnStarting,
  rollbackChatTurnStarting,
} from "./chatTurnLifecycle";
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
    // Ultracode is gated to Opus 4.8 in the composer. Re-check the model here
    // so a lingering toggle (e.g. the user switched away from 4.8) never sends
    // ultracode to a non-xhigh-capable model.
    const ultracode =
      (state.ultracode[sessionId] || false) && isUltracodeSupported(selectedModel ?? "");

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
        ultracode,
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
        ultracode || undefined,
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
