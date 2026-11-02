import type { ChatMessage, ChatRole } from "../types/chat";

export interface MakeChatMessageInput {
  workspaceId: string;
  sessionId: string;
  role: ChatRole;
  content: string;
  /** Defaults to a fresh `crypto.randomUUID()`. */
  id?: string;
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
  thinking?: string | null;
  /** Usage/cost fields — all default to `null`, which is what every
   *  client-synthesized message (user echo, system notice, sentinel) wants. */
  costUsd?: number | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
}

/** Build a client-side `ChatMessage` with every usage field defaulted to
 *  `null`. Keeps the wire shape in one place so adding a column to the Rust
 *  `ChatMessage` struct means touching one factory, not every call site. */
export function makeChatMessage(input: MakeChatMessageInput): ChatMessage {
  return {
    id: input.id ?? crypto.randomUUID(),
    workspace_id: input.workspaceId,
    chat_session_id: input.sessionId,
    role: input.role,
    content: input.content,
    cost_usd: input.costUsd ?? null,
    duration_ms: input.durationMs ?? null,
    created_at: input.createdAt ?? new Date().toISOString(),
    thinking: input.thinking ?? null,
    input_tokens: input.inputTokens ?? null,
    output_tokens: input.outputTokens ?? null,
    cache_read_tokens: input.cacheReadTokens ?? null,
    cache_creation_tokens: input.cacheCreationTokens ?? null,
  };
}
