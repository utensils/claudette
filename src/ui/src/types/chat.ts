export type ChatRole = "User" | "Assistant" | "System";

export interface ChatMessage {
  id: string;
  workspace_id: string;
  role: ChatRole;
  content: string;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
}
