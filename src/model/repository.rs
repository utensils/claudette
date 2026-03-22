#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    pub created_at: String,
    /// Runtime-only: whether the repo path still exists on disk. Not persisted.
    pub path_valid: bool,
}
