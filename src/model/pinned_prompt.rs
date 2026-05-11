use serde::{Deserialize, Serialize};

/// A user-curated prompt shortcut surfaced as a pill on the chat composer.
///
/// `repo_id == None` means the prompt is global (visible in every repo).
/// Repo-scoped prompts shadow globals that share their `display_name`.
///
/// The four toolbar overrides are tri-state. `None` means "inherit the
/// session's current toolbar value when this prompt is used"; `Some(bool)`
/// forces the toggle to that value. The write is sticky — the chat composer
/// applies the forced values to the toolbar slice, so follow-up turns also
/// inherit them until the user flips them back.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinnedPrompt {
    pub id: i64,
    pub repo_id: Option<String>,
    pub display_name: String,
    pub prompt: String,
    pub auto_send: bool,
    pub plan_mode: Option<bool>,
    pub fast_mode: Option<bool>,
    pub thinking_enabled: Option<bool>,
    pub chrome_enabled: Option<bool>,
    pub sort_order: i32,
    pub created_at: String,
}
