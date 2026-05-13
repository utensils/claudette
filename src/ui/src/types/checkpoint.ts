export interface ConversationCheckpoint {
  id: string;
  workspace_id: string;
  message_id: string;
  commit_hash: string | null;
  has_file_state: boolean;
  turn_index: number;
  message_count: number;
  created_at: string;
}

export interface TurnToolActivityData {
  id: string;
  checkpoint_id: string;
  tool_use_id: string;
  tool_name: string;
  input_json: string;
  result_text: string;
  summary: string;
  sort_order: number;
  assistant_message_ordinal: number;
  agent_task_id: string | null;
  agent_description: string | null;
  agent_last_tool_name: string | null;
  agent_tool_use_count: number | null;
  agent_status: string | null;
  agent_tool_calls_json: string;
  agent_thinking_blocks_json: string;
  agent_result_text: string | null;
}

export interface CompletedTurnData {
  checkpoint_id: string;
  message_id: string;
  turn_index: number;
  message_count: number;
  commit_hash: string | null;
  activities: TurnToolActivityData[];
}
