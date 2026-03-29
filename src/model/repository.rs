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
    /// Runtime-only: whether the repo path still exists on disk. Not persisted.
    pub path_valid: bool,
}
