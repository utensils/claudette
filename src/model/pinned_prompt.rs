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
///
/// The launch options (`new_session` / `model` / `model_provider`) decide
/// *where* the prompt runs and *on what*; see [`PinnedPromptLaunch`].
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
    pub new_session: bool,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
}

/// Where a pinned prompt runs and on which model.
///
/// Kept as its own type so the create/update paths take one cohesive
/// argument instead of three more positional booleans/strings, and so the
/// "inherit" semantics live in one documented place.
///
/// - `new_session`: open a fresh chat tab in the current workspace and run
///   the prompt there. `false` (the default) runs it in the active session,
///   which is the pre-existing behaviour.
/// - `model` / `model_provider`: select this model before the prompt is
///   sent. `None` inherits whatever the target session already has. The two
///   travel together — a model id is only unique within its backend — so
///   `model_provider` is meaningless without `model` and is normalized away
///   by [`PinnedPromptLaunch::normalized`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PinnedPromptLaunch {
    #[serde(default)]
    pub new_session: bool,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_provider: Option<String>,
}

impl PinnedPromptLaunch {
    /// Collapses blank strings to `None` and drops a dangling
    /// `model_provider` that has no `model` to qualify. Persisting a
    /// provider without a model would read back as "inherit the model but
    /// force the backend", which isn't a state the UI can express.
    pub fn normalized(&self) -> Self {
        let model = self
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let model_provider = model.as_ref().and(
            self.model_provider
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        );
        Self {
            new_session: self.new_session,
            model,
            model_provider,
        }
    }
}
