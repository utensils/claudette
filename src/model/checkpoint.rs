use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationCheckpoint {
    pub id: String,
    pub workspace_id: String,
    pub message_id: String,
    pub commit_hash: Option<String>,
    pub turn_index: i32,
    pub message_count: i32,
    pub created_at: String,
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
}

/// Grouped checkpoint + activities for loading completed turns.
#[derive(Debug, Clone, Serialize)]
pub struct CompletedTurnData {
    pub checkpoint_id: String,
    pub message_id: String,
    pub turn_index: i32,
    pub message_count: i32,
    pub activities: Vec<TurnToolActivity>,
}
