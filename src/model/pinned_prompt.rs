use serde::{Deserialize, Serialize};

/// A user-curated prompt shortcut surfaced as a pill on the chat composer.
///
/// `repo_id == None` means the prompt is global (visible in every repo).
/// Repo-scoped prompts shadow globals that share their `display_name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinnedPrompt {
    pub id: i64,
    pub repo_id: Option<String>,
    pub display_name: String,
    pub prompt: String,
    pub auto_send: bool,
    pub sort_order: i32,
    pub created_at: String,
}
