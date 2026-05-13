import { invoke } from "@tauri-apps/api/core";
import type { ChatSession } from "../../types";

export function listChatSessions(
  workspaceId: string,
  includeArchived: boolean = false,
): Promise<ChatSession[]> {
  return invoke("list_chat_sessions", { workspaceId, includeArchived });
}

export function getChatSession(sessionId: string): Promise<ChatSession> {
  return invoke("get_chat_session", { sessionId });
}

export function createChatSession(workspaceId: string): Promise<ChatSession> {
  return invoke("create_chat_session", { workspaceId });
}

export function renameChatSession(
  sessionId: string,
  name: string,
): Promise<void> {
  return invoke("rename_chat_session", { sessionId, name });
}

export function setSessionCliInvocation(
  chatSessionId: string,
  invocation: string,
): Promise<void> {
  return invoke("set_session_cli_invocation", {
    chatSessionId,
    invocation,
  });
}

/**
 * Reassign chat-session sort_order to match the supplied id sequence.
 * Used by the unified workspace-tab drag-reorder; only sessions persist —
 * file/diff tabs reorder in volatile frontend state.
 */
export function reorderChatSessions(
  workspaceId: string,
  sessionIds: string[],
): Promise<void> {
  return invoke("reorder_chat_sessions", { workspaceId, sessionIds });
}

/**
 * Restore a previously archived chat session — flips status back to active
 * and clears `archived_at` so the session reappears in the workspace's
 * tab list. The frontend should add the returned row back to the store.
 */
export function restoreChatSession(
  sessionId: string,
): Promise<ChatSession> {
  return invoke("restore_chat_session", { sessionId });
}

/**
 * Archive a chat session. By default, when this was the workspace's last
 * active session, the backend auto-creates a fresh "New chat" replacement
 * and returns it (so the frontend can select the new tab). Pass
 * `autoReplace: false` to opt out — the workspace becomes session-less and
 * the frontend can render its empty-tabs view. Returns the auto-created
 * session in the auto-replace path; `null` otherwise.
 */
export function archiveChatSession(
  sessionId: string,
  autoReplace: boolean = true,
): Promise<ChatSession | null> {
  return invoke("archive_chat_session", { sessionId, autoReplace });
}
