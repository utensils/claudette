export type ChatRole = "User" | "Assistant" | "System";

export interface ChatMessage {
  id: string;
  workspace_id: string;
  role: ChatRole;
  content: string;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
  thinking: string | null;
}

/** A persisted image attachment returned from the backend (base64-encoded). */
export interface ChatAttachment {
  id: string;
  message_id: string;
  filename: string;
  media_type: string;
  data_base64: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
}

/** Payload shape for sending attachment data to the backend. */
export interface AttachmentInput {
  filename: string;
  media_type: string;
  data_base64: string;
}

/** A staged attachment in the frontend before the message is sent. */
export interface PendingAttachment {
  id: string;
  filename: string;
  media_type: string;
  data_base64: string;
  preview_url: string; // blob: URL for thumbnail display
  size_bytes: number;
}
