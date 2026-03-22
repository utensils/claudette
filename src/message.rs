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
    BrowseRepoPath,
    RepoPathSelected(Option<String>),
    ConfirmAddRepo,
    RepoAdded(Result<Repository, String>),

    // Repository management
    RemoveRepository(String),                  // repo_id
    RepositoryRemoved(Result<String, String>), // Ok(repo_id)
    ShowRelinkRepo(String),                    // repo_id
    HideRelinkRepo,
    RelinkRepoPathChanged(String),
    BrowseRelinkPath,
    RelinkPathSelected(Option<String>),
    ConfirmRelinkRepo,
    RepoRelinked(Result<(String, String), String>), // Ok((repo_id, new_path))

    // Create workspace
    ShowCreateWorkspace(String), // repo_id
    HideCreateWorkspace,
    CreateWorkspaceNameChanged(String),
    RegenerateWorkspaceName,
    ConfirmCreateWorkspace,
    WorkspaceCreated(Result<Workspace, String>),

    // Workspace lifecycle
    ArchiveWorkspace(String),
    WorkspaceArchived(Result<String, String>),
    RestoreWorkspace(String),
    WorkspaceRestored(Result<(String, String), String>), // Ok((ws_id, worktree_path))
    DeleteWorkspace(String),
    HideDeleteWorkspace,
    ConfirmDeleteWorkspace,
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

    // App lifecycle
    ApplyDockIcon,

    // Keyboard
    EscapePressed,
}
