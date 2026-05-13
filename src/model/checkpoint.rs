use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationCheckpoint {
    pub id: String,
    pub workspace_id: String,
    pub chat_session_id: String,
    pub message_id: String,
    pub commit_hash: Option<String>,
    /// Whether this checkpoint has file snapshot data in the `checkpoint_files`
    /// table. When true, rollback restores files from SQLite instead of git.
    pub has_file_state: bool,
    pub turn_index: i32,
    pub message_count: i32,
    pub created_at: String,
}

/// A single file captured in a checkpoint snapshot.
#[derive(Debug, Clone)]
pub struct CheckpointFile {
    pub id: String,
    pub checkpoint_id: String,
    pub file_path: String,
    pub content: Option<Vec<u8>>,
    pub file_mode: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnToolActivity {
    pub id: String,
    pub checkpoint_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub input_json: String,
    pub result_text: String,
    pub summary: String,
    pub sort_order: i32,
    /// Number of assistant text messages in this turn after which the tool
    /// activity should render. Zero means before the first assistant message.
    pub assistant_message_ordinal: i32,
    pub agent_task_id: Option<String>,
    pub agent_description: Option<String>,
    pub agent_last_tool_name: Option<String>,
    pub agent_tool_use_count: Option<i32>,
    pub agent_status: Option<String>,
    pub agent_tool_calls_json: String,
    #[serde(default = "empty_json_array")]
    pub agent_thinking_blocks_json: String,
    #[serde(default)]
    pub agent_result_text: Option<String>,
}

fn empty_json_array() -> String {
    "[]".to_string()
}

/// Grouped checkpoint + activities for loading completed turns.
#[derive(Debug, Clone, Serialize)]
pub struct CompletedTurnData {
    pub checkpoint_id: String,
    pub message_id: String,
    pub turn_index: i32,
    pub message_count: i32,
    pub commit_hash: Option<String>,
    pub activities: Vec<TurnToolActivity>,
}
