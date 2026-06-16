use serde::Serialize;

/// A finished-work conclusion the agent presented via the `present_conclusion`
/// MCP tool. Persisted in `agent_conclusions` so it survives reload/export and
/// can be rendered inline in the transcript as a conclusion card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConclusion {
    pub id: String,
    pub chat_session_id: String,
    pub workspace_id: String,
    /// User message that triggered the turn this conclusion belongs to, used
    /// as the FK anchor so a rollback removes the conclusion too. `None` when
    /// there was no in-flight turn to anchor against.
    pub message_id: Option<String>,
    pub title: Option<String>,
    pub summary: String,
    /// Paths the agent listed as artifacts of the work. Stored as a JSON array
    /// in the `artifacts_json` column; always present (possibly empty) here.
    pub artifacts: Vec<String>,
    pub created_at: String,
}
