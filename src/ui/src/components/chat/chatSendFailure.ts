import { isClaudeAuthError } from "../auth/claudeAuth";
import { makeChatMessage } from "../../utils/chatMessage";
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
  return makeChatMessage({
    id,
    workspaceId,
    sessionId,
    role: "System",
    content: error,
    createdAt,
  });
}
