import { isClaudeAuthError } from "../auth/claudeAuth";
import type { ChatMessage } from "../../types/chat";

interface SendFailureMessageInput {
  error: string;
  workspaceId: string;
  sessionId: string;
  id: string;
  createdAt: string;
}

export function shouldRecordSendFailureInChat(error: string): boolean {
  return isClaudeAuthError(error);
}

export function buildSendFailureSystemMessage({
  error,
  workspaceId,
  sessionId,
  id,
  createdAt,
}: SendFailureMessageInput): ChatMessage {
  return {
    id,
    workspace_id: workspaceId,
    chat_session_id: sessionId,
    role: "System",
    content: error,
    cost_usd: null,
    duration_ms: null,
    created_at: createdAt,
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
}
