use serde::{Deserialize, Serialize};

/// A partial observation. Native IDs are scoped to the chat and harness.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentRunUpdate {
    pub harness: String,
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub assignment: Option<String>,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub tool_use_id: Option<String>,
}

/// Native lifecycle and model-authored progress are independent observations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SubagentRun {
    pub session_id: String,
    #[serde(flatten)]
    pub native: SubagentRunUpdate,
    pub linked_session_id: Option<String>,
    pub report_kind: Option<String>,
    pub report_summary: Option<String>,
    pub updated_at: String,
    pub revision: i64,
}
