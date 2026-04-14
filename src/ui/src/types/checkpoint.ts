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
}

export interface CompletedTurnData {
  checkpoint_id: string;
  message_id: string;
  turn_index: number;
  message_count: number;
  activities: TurnToolActivityData[];
}
