/** Payload shape emitted from the Rust backend via Tauri events. */
export interface AgentStreamPayload {
  workspace_id: string;
  event: AgentEvent;
}

export type AgentEvent =
  | { Stream: StreamEvent }
  | { ProcessExited: number | null };

export type StreamEvent =
  | { type: "system"; subtype: string; session_id?: string }
  | { type: "stream_event"; event: InnerStreamEvent }
  | { type: "assistant"; message: AssistantMessage }
  | {
      type: "result";
      subtype: string;
      result?: string;
      total_cost_usd?: number;
      duration_ms?: number;
    }
  | { type: "user"; message: UserEventMessage }
  | { type: "Unknown" };

export type InnerStreamEvent =
  | { type: "message_start" }
  | {
      type: "content_block_start";
      index: number;
      content_block?: StartContentBlock;
    }
  | { type: "content_block_delta"; index: number; delta: Delta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta" }
  | { type: "message_stop" }
  | { type: "Unknown" };

export type Delta =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_delta"; partial_json?: string }
  | { type: "input_json_delta"; partial_json?: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "Unknown" };

export type StartContentBlock =
  | { type: "tool_use"; id: string; name: string }
  | { type: "text" }
  | { type: "thinking" }
  | { type: "Unknown" };

export interface AssistantMessage {
  content: ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string }
  | { type: "Unknown" };

export interface UserEventMessage {
  content: UserContentBlock[];
}

export type UserContentBlock =
  | { type: "tool_result"; tool_use_id: string; content: unknown }
  | { type: "Unknown" };
