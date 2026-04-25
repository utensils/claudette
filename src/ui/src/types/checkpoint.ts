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
  /** Index of the segment this activity belongs to within its turn. Activities
   *  sharing a `group_id` render as a single tool-group; distinct values
   *  become distinct groups or subagent cards. Null on legacy rows persisted
   *  before the segment column existed — the reader treats those as one group. */
  group_id?: number | null;
}

export interface CompletedTurnData {
  checkpoint_id: string;
  message_id: string;
  turn_index: number;
  message_count: number;
  commit_hash: string | null;
  activities: TurnToolActivityData[];
}
