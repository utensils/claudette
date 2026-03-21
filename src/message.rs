use crate::model::{Repository, Workspace};

#[derive(Debug, Clone)]
pub enum SidebarFilter {
    All,
    Active,
    Archived,
}

#[derive(Debug, Clone)]
pub enum Message {
    // Sidebar
    ToggleSidebar,
    SelectWorkspace(String),
    ToggleRepoCollapsed(String),
    SetSidebarFilter(SidebarFilter),

    // Data loading
    DataLoaded(Result<(Vec<Repository>, Vec<Workspace>), String>),

    // Add repository
    ShowAddRepo,
    HideAddRepo,
    AddRepoPathChanged(String),
    ConfirmAddRepo,
    RepoAdded(Result<Repository, String>),

    // Create workspace
    ShowCreateWorkspace(String), // repo_id
    HideCreateWorkspace,
    CreateWorkspaceNameChanged(String),
    ConfirmCreateWorkspace,
    WorkspaceCreated(Result<Workspace, String>),

    // Workspace lifecycle
    ArchiveWorkspace(String),
    WorkspaceArchived(Result<String, String>),
    RestoreWorkspace(String),
    WorkspaceRestored(Result<(String, String), String>), // Ok((ws_id, worktree_path))
    DeleteWorkspace(String),
    WorkspaceDeleted(Result<String, String>),

    // Fuzzy finder
    ToggleFuzzyFinder,
    FuzzyQueryChanged(String),
    #[allow(dead_code)]
    FuzzyNavigateUp,
    #[allow(dead_code)]
    FuzzyNavigateDown,
    #[allow(dead_code)]
    FuzzyConfirm,

    // Keyboard
    EscapePressed,
}
