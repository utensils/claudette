export type ChatRole = "User" | "Assistant" | "System";

export interface ChatMessage {
  id: string;
  workspace_id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
  thinking: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

export type SessionStatus = "Active" | "Archived";
export type SessionAttentionKind = "Ask" | "Plan";
export type SessionAgentStatus = "Idle" | "Running" | "Stopped";

/** A chat session (tab) within a workspace. Matches the Rust `ChatSession` struct. */
export interface ChatSession {
  id: string;
  workspace_id: string;
  claude_session_id: string | null;
  name: string;
  name_edited: boolean;
  turn_count: number;
  sort_order: number;
  status: SessionStatus;
  created_at: string;
  archived_at: string | null;
  agent_status: SessionAgentStatus;
  needs_attention: boolean;
  attention_kind: SessionAttentionKind | null;
}

/** A persisted attachment returned from the backend (base64-encoded). */
export interface ChatAttachment {
  id: string;
  message_id: string;
  filename: string;
  media_type: string;
  data_base64: string;
  text_content: string | null;
  width: number | null;
  height: number | null;
  size_bytes: number;
  /** Whether the user composed this attachment or the agent delivered it via
   *  `mcp__claudette__send_to_user`. Defaults to `"user"` for legacy rows. */
  origin?: "user" | "agent";
  /** For `origin === "agent"`: the MCP tool_use_id this delivery belongs to,
   *  if known. v1 leaves this null; reserved for future per-tool-call grouping. */
  tool_use_id?: string | null;
}

/** Payload of the `agent-attachment-created` Tauri event. The Rust bridge
 *  emits this whenever the agent calls `mcp__claudette__send_to_user`. */
export interface AgentAttachmentEvent {
  workspace_id: string;
  message_id: string;
  attachment: ChatAttachment & { caption?: string | null };
}

/** Payload shape for sending attachment data to the backend. */
export interface AttachmentInput {
  filename: string;
  media_type: string;
  data_base64: string;
  text_content?: string;
}

/** A staged attachment in the frontend before the message is sent. */
export interface PendingAttachment {
  id: string;
  filename: string;
  media_type: string;
  data_base64: string;
  preview_url: string; // blob: URL for thumbnail display
  size_bytes: number;
  text_content: string | null;
}
