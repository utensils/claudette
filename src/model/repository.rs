use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    /// Immutable slug derived from the directory basename at add time.
    /// Used for filesystem paths (worktree directories). Never changes after creation.
    pub path_slug: String,
    /// Lucide icon name (e.g. "rocket", "code"). None means use default icon.
    pub icon: Option<String>,
    pub created_at: String,
    /// Per-user setup script configured in the Settings UI. None means no script.
    pub setup_script: Option<String>,
    /// Custom instructions appended to the agent's system prompt for every chat.
    pub custom_instructions: Option<String>,
    /// Display order in the sidebar. Lower values appear first.
    pub sort_order: i32,
    /// Custom instructions for how branch names should be generated during auto-rename.
    pub branch_rename_preferences: Option<String>,
    /// When true, setup scripts run automatically without a confirmation modal.
    pub setup_script_auto_run: bool,
    /// Per-user archive script configured in the Settings UI. Runs before the worktree
    /// is removed when archiving. None means no script.
    pub archive_script: Option<String>,
    /// When true, archive scripts run automatically without a confirmation modal.
    pub archive_script_auto_run: bool,
    /// Explicit remote-tracking branch to use as the base for new workspaces
    /// (e.g. "origin/main"). None means auto-detect via git.
    pub base_branch: Option<String>,
    /// Explicit remote name for push/pull/PR operations (e.g. "origin").
    /// None means auto-detect (first configured remote).
    pub default_remote: Option<String>,
    /// Runtime-only: whether the repo path still exists on disk. Not persisted.
    pub path_valid: bool,
}
