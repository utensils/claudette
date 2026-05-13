import { invoke } from "@tauri-apps/api/core";
import type {
  AttachmentInput,
  ChatAttachment,
  ChatHistoryPage,
  ChatMessage,
} from "../../types";
import type { ConversationCheckpoint } from "../../types/checkpoint";

export function loadChatHistory(sessionId: string): Promise<ChatMessage[]> {
  return invoke("load_chat_history", { sessionId });
}

export function loadChatHistoryPage(
  sessionId: string,
  limit: number,
  beforeMessageId?: string,
): Promise<ChatHistoryPage> {
  return invoke("load_chat_history_page", {
    sessionId,
    limit,
    beforeMessageId: beforeMessageId ?? null,
  });
}

export function sendChatMessage(
  sessionId: string,
  content: string,
  mentionedFiles?: string[],
  permissionLevel?: string,
  model?: string,
  fastMode?: boolean,
  thinkingEnabled?: boolean,
  planMode?: boolean,
  effort?: string,
  chromeEnabled?: boolean,
  disable1mContext?: boolean,
  backendId?: string,
  attachments?: AttachmentInput[],
  messageId?: string,
): Promise<void> {
  return invoke("send_chat_message", {
    sessionId,
    messageId: messageId ?? null,
    content,
    mentionedFiles: mentionedFiles ?? null,
    permissionLevel: permissionLevel ?? null,
    model: model ?? null,
    fastMode: fastMode ?? null,
    thinkingEnabled: thinkingEnabled ?? null,
    planMode: planMode ?? null,
    effort: effort ?? null,
    chromeEnabled: chromeEnabled ?? null,
    disable1mContext: disable1mContext ?? null,
    backendId: backendId ?? null,
    attachments: attachments ?? null,
  });
}

export function steerQueuedChatMessage(
  sessionId: string,
  content: string,
  mentionedFiles?: string[],
  attachments?: AttachmentInput[],
  messageId?: string,
): Promise<ConversationCheckpoint | null> {
  return invoke("steer_queued_chat_message", {
    sessionId,
    messageId: messageId ?? null,
    content,
    mentionedFiles: mentionedFiles ?? null,
    attachments: attachments ?? null,
  });
}

export function loadAttachmentsForSession(
  sessionId: string,
): Promise<ChatAttachment[]> {
  return invoke("load_attachments_for_session", { sessionId });
}

export function loadAttachmentData(
  attachmentId: string,
): Promise<string> {
  return invoke("load_attachment_data", { attachmentId });
}

export function readFileAsBase64(path: string): Promise<ChatAttachment> {
  return invoke("read_file_as_base64", { path });
}

export function stopAgent(sessionId: string): Promise<void> {
  return invoke("stop_agent", { sessionId });
}

export function resetAgentSession(sessionId: string): Promise<void> {
  return invoke("reset_agent_session", { sessionId });
}

export function clearAttention(sessionId: string): Promise<void> {
  return invoke("clear_attention", { sessionId });
}

/**
 * Send the user's answers for a pending AskUserQuestion tool_use, keyed by
 * question text. The Rust side layers them onto the tool's original input as
 * `updatedInput.answers` and writes a `control_response` to the CLI.
 */
export function submitAgentAnswer(
  sessionId: string,
  toolUseId: string,
  answers: Record<string, string>,
): Promise<void> {
  return invoke("submit_agent_answer", {
    sessionId,
    toolUseId,
    answers,
    annotations: null,
  });
}

/**
 * Approve or reject a pending ExitPlanMode tool_use. On approve the CLI
 * runs the tool's `call()` and emits the normal "Plan approved" tool_result.
 */
export function submitPlanApproval(
  sessionId: string,
  toolUseId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  return invoke("submit_plan_approval", {
    sessionId,
    toolUseId,
    approved,
    reason: reason ?? null,
  });
}
