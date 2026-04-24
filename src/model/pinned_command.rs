use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PinnedCommand {
    pub id: i64,
    pub repo_id: String,
    pub command_name: String,
    pub sort_order: i32,
    pub created_at: String,
    pub use_count: i64,
}
