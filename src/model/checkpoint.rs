use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationCheckpoint {
    pub id: String,
    pub workspace_id: String,
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
    /// Index of the segment this activity belongs to within its turn. Rows
    /// sharing a `group_id` are rendered as one tool-group; distinct values
    /// become distinct groups or subagent cards. `None` on pre-migration rows
    /// — the reader treats those as a single group covering the whole turn.
    #[serde(default)]
    pub group_id: Option<i32>,
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
