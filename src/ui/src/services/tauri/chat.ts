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

/**
 * Queue a cross-harness migration so the next user turn carries the
 * prior conversation as a synthetic prelude. Used when the model the
 * user just picked routes through a different runtime harness than
 * the current session's (e.g. Anthropic Claude Code -> Codex
 * app-server, or Codex -> Pi SDK).
 *
 * The persisted chat_messages rows are untouched — the UI keeps
 * showing every prior turn. Internally the Rust side:
 *   1. Builds a prelude from chat_messages
 *   2. Mints a fresh session_id + zero turn_count
 *   3. Stashes the prelude on the in-memory AgentSessionState
 *
 * On the next `send_chat_message`, the prelude is prepended to the
 * user's content *before* the spawn so the new harness sees the full
 * prior context as the leading text of its turn 1. The user sees
 * their own message in chat, unchanged.
 *
 * Falling back to `resetAgentSession` is the right choice when this
 * call fails: the migration would have started a fresh conversation
 * anyway, just without the prior context surfaced to the new
 * harness.
 */
export function prepareCrossHarnessMigration(sessionId: string): Promise<void> {
  return invoke("prepare_cross_harness_migration", { sessionId });
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

/**
 * Approve or reject a pending generic agent approval. The Rust side uses the
 * same approval resolver as plan approval so Codex app-server approvals and
 * Claude ExitPlanMode keep identical validation and response behavior.
 */
export function submitAgentApproval(
  sessionId: string,
  toolUseId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  return invoke("submit_agent_approval", {
    sessionId,
    toolUseId,
    approved,
    reason: reason ?? null,
  });
}
