use serde::{Deserialize, Serialize};

/// Lifecycle record for a single Claude CLI agent session.
///
/// A session spans from the first turn (when a new `session_id` is minted)
/// until the process exits cleanly, the conversation is cleared/rolled back,
/// or the workspace is archived.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub id: String,
    pub workspace_id: Option<String>,
    pub repository_id: String,
    pub started_at: String,
    pub last_message_at: String,
    pub ended_at: Option<String>,
    pub turn_count: i64,
    pub completed_ok: bool,
}

/// A git commit observed in a workspace's worktree during an agent session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCommit {
    pub commit_hash: String,
    pub workspace_id: Option<String>,
    pub repository_id: String,
    pub session_id: Option<String>,
    pub additions: i64,
    pub deletions: i64,
    pub files_changed: i64,
    pub committed_at: String,
}

/// Frozen lifetime aggregates captured when a workspace is hard-deleted.
///
/// Populated inside the same transaction as `delete_workspace`, BEFORE the
/// cascade wipes the raw rows. Keeps dashboard totals stable across deletes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletedWorkspaceSummary {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub repository_id: String,
    pub workspace_created_at: String,
    pub deleted_at: String,
    pub sessions_started: i64,
    pub sessions_completed: i64,
    pub total_turns: i64,
    pub total_session_duration_ms: i64,
    pub commits_made: i64,
    pub total_additions: i64,
    pub total_deletions: i64,
    pub total_files_changed: i64,
    pub messages_user: i64,
    pub messages_assistant: i64,
    pub messages_system: i64,
    pub total_cost_usd: f64,
    pub first_message_at: Option<String>,
    pub last_message_at: Option<String>,
    pub slash_commands_used: i64,
}

/// Aggregated metrics for the top-of-dashboard `StatsStrip`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardMetrics {
    pub active_sessions: u32,
    pub sessions_today: u32,
    pub commits_today: u32,
    pub additions_7d: u64,
    pub deletions_7d: u64,
    pub cost_30d_usd: f64,
    pub success_rate_30d: f32,
    pub commits_daily_14d: Vec<u32>,
    pub cost_daily_30d: Vec<f64>,
}

/// Per-workspace metrics shown in the workspace-card `MicroStats` chip.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetrics {
    pub commits_count: u32,
    pub additions: u64,
    pub deletions: u64,
    pub latest_session_turns: u32,
}

/// One row in the repo leaderboard widget.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoLeaderRow {
    pub repository_id: String,
    pub sessions: u32,
    pub commits: u32,
    pub total_cost_usd: f64,
}

/// One cell in the 13-week session heatmap.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapCell {
    pub dow: u8,
    pub week: u8,
    pub count: u32,
}

/// One dot on the 24-hour session timeline.
///
/// `ended_at` is an RFC3339 UTC string (`YYYY-MM-DDTHH:MM:SSZ`) so the
/// frontend's `Date.parse` interprets it as UTC regardless of the user's
/// local timezone.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDot {
    pub ended_at: String,
    pub completed_ok: bool,
    pub workspace_id: String,
}

/// Payload for the collapsible analytics section at the bottom of the dashboard.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsMetrics {
    pub repo_leaderboard: Vec<RepoLeaderRow>,
    pub heatmap: Vec<HeatmapCell>,
    pub turn_histogram: Vec<u32>,
    pub top_slash_commands: Vec<(String, u32)>,
    pub recent_sessions_24h: Vec<SessionDot>,
}
