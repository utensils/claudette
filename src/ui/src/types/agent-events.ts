/** Payload shape emitted from the Rust backend via Tauri events. */
export interface AgentStreamPayload {
  workspace_id: string;
  event: AgentEvent;
}

export type AgentEvent =
  | { Stream: StreamEvent }
  | { ProcessExited: number | null };

export type StreamEvent =
  | {
      type: "system";
      subtype: string;
      /** Rust serializes `Option<String>` as `null` (no `skip_serializing_if`),
       * so the wire payload carries `null` when absent. */
      session_id?: string | null;
      /** Only present on `subtype: "status"` events. */
      status?: string | null;
      /** Only present on the end-of-compaction status event. Rust
       * serializes `Option<String>` as `null` (no `skip_serializing_if`),
       * so the wire payload carries `null` when absent. */
      compact_result?: string | null;
      /** Only present on `subtype: "compact_boundary"` events. Rust
       * serializes `Option<CompactMetadata>` as `null` when absent. */
      compact_metadata?: {
        trigger: string;
        pre_tokens: number;
        post_tokens: number;
        duration_ms: number;
      } | null;
    }
  | { type: "stream_event"; event: InnerStreamEvent }
  | { type: "assistant"; message: AssistantMessage }
  | {
      type: "result";
      subtype: string;
      result?: string;
      total_cost_usd?: number;
      duration_ms?: number;
      // Rust serializes `Option<T>` as `null` when absent (no
      // `skip_serializing_if`), so the wire payload can carry either
      // `{ usage: null }` or `usage` omitted entirely. The cache fields
      // can likewise be `null` when the CLI doesn't emit them.
      usage?:
        | {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number | null;
            cache_read_input_tokens?: number | null;
            // Per-iteration breakdown. The CLI emits a single-entry array
            // containing the FINAL iteration's per-call usage, regardless
            // of how many backend API calls the Claudette-level turn
            // contained. The ContextMeter uses this (not the top-level
            // aggregate) to reflect actual end-of-turn context size.
            iterations?: Array<{
              input_tokens: number;
              output_tokens: number;
              cache_read_input_tokens?: number | null;
              cache_creation_input_tokens?: number | null;
            }>;
          }
        | null;
    }
  | { type: "user"; message: UserEventMessage; isSynthetic?: boolean }
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
  | {
      type: "message_delta";
      // Per-assistant-message cumulative usage; the Rust side serializes
      // `Option<TokenUsage>` as `null` when absent, so the wire payload
      // can carry `usage: null`. Phase 1's frontend does not consume
      // this — only `Result.usage` drives the TurnFooter readout — but
      // the type mirrors what the bridge actually emits.
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      } | null;
    }
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
  content: string | UserContentBlock[];
}

export type UserContentBlock =
  | { type: "tool_result"; tool_use_id: string; content: unknown }
  | { type: "Unknown" };
