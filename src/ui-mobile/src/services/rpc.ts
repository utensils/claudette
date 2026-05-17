import { invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  ChatSession,
  InitialData,
  PairResult,
  SavedConnection,
  VersionInfo,
} from "../types";

// Thin wrappers around the Tauri-side commands. Centralizing them here
// (rather than calling `invoke<T>(...)` inline everywhere) means a
// screen never has to know the exact Rust command-name string.

export function getVersion(): Promise<VersionInfo> {
  return invoke<VersionInfo>("version");
}

export function pairWithConnectionString(
  connectionString: string,
): Promise<PairResult> {
  return invoke<PairResult>("pair_with_connection_string", {
    connectionString,
  });
}

export function listSavedConnections(): Promise<SavedConnection[]> {
  return invoke<SavedConnection[]>("list_saved_connections");
}

export function connectSaved(id: string): Promise<SavedConnection> {
  return invoke<SavedConnection>("connect_saved", { id });
}

export function forgetConnection(id: string): Promise<void> {
  return invoke<void>("forget_connection", { id });
}

// Generic JSON-RPC passthrough. The webview is the protocol authority —
// per-method Tauri commands would just duplicate the WSS server's
// method dispatch on the phone for no real benefit.
export function sendRpc<T = unknown>(
  connectionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>("send_rpc", {
    connectionId,
    method,
    params,
  });
}

// ---------- Typed wrappers around the common WSS server methods ----------
// One call per method, so screens don't have to memorize the wire names.

export function loadInitialData(connectionId: string): Promise<InitialData> {
  return sendRpc<InitialData>(connectionId, "load_initial_data");
}

export function listChatSessions(
  connectionId: string,
  workspaceId: string,
  includeArchived = false,
): Promise<ChatSession[]> {
  return sendRpc<ChatSession[]>(connectionId, "list_chat_sessions", {
    workspace_id: workspaceId,
    include_archived: includeArchived,
  });
}

export function createChatSession(
  connectionId: string,
  workspaceId: string,
): Promise<ChatSession> {
  return sendRpc<ChatSession>(connectionId, "create_chat_session", {
    workspace_id: workspaceId,
  });
}

export function loadChatHistory(
  connectionId: string,
  chatSessionId: string,
): Promise<ChatMessage[]> {
  return sendRpc<ChatMessage[]>(connectionId, "load_chat_history", {
    chat_session_id: chatSessionId,
  });
}

export function sendChatMessage(
  connectionId: string,
  chatSessionId: string,
  content: string,
  permissionLevel: string = "full",
): Promise<unknown> {
  return sendRpc(connectionId, "send_chat_message", {
    chat_session_id: chatSessionId,
    content,
    permission_level: permissionLevel,
  });
}

export function stopAgent(
  connectionId: string,
  chatSessionId: string,
): Promise<unknown> {
  return sendRpc(connectionId, "stop_agent", {
    chat_session_id: chatSessionId,
  });
}

export function submitAgentAnswer(
  connectionId: string,
  chatSessionId: string,
  toolUseId: string,
  answers: Record<string, string>,
): Promise<unknown> {
  return sendRpc(connectionId, "submit_agent_answer", {
    chat_session_id: chatSessionId,
    tool_use_id: toolUseId,
    answers,
  });
}

export function submitPlanApproval(
  connectionId: string,
  chatSessionId: string,
  toolUseId: string,
  approved: boolean,
  reason?: string,
): Promise<unknown> {
  return sendRpc(connectionId, "submit_plan_approval", {
    chat_session_id: chatSessionId,
    tool_use_id: toolUseId,
    approved,
    reason,
  });
}
