use crate::agent::StreamEvent;
use crate::model::diff::{DiffFile, DiffViewMode, FileDiff};
use crate::model::{ChatMessage, Repository, Workspace};

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
    #[allow(clippy::type_complexity)]
    DataLoaded(Result<(Vec<Repository>, Vec<Workspace>, Option<String>), String>),

    // Add repository
    ShowAddRepo,
    HideAddRepo,
    AddRepoPathChanged(String),
    BrowseRepoPath,
    RepoPathSelected(Option<String>),
    ConfirmAddRepo,
    RepoAdded(Result<Repository, String>),

    // Repository settings
    ShowRepoSettings(String), // repo_id
    HideRepoSettings,
    RepoSettingsNameChanged(String),
    ConfirmRepoSettings,
    RepoSettingsUpdated(Result<(String, String, Option<String>), String>), // Ok((repo_id, name, icon))

    // Icon picker
    ShowIconPicker,
    HideIconPicker,
    IconPickerQueryChanged(String),
    SelectIcon(Option<String>), // icon name or None to clear

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

    // App settings
    ShowAppSettings,
    HideAppSettings,
    AppSettingsWorktreeBaseChanged(String),
    BrowseWorktreeBase,
    WorktreeBaseSelected(Option<String>),
    ConfirmAppSettings,
    AppSettingsUpdated(Result<String, String>), // Ok(new_worktree_base)

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

    // --- Agent lifecycle ---
    AgentStart(String), // workspace_id
    AgentStop(String),  // workspace_id
    AgentSpawned(Result<(String, crate::app::AgentHandle), String>), // Ok((ws_id, handle))
    AgentStopped(Result<String, String>), // Ok(ws_id)
    AgentStreamEvent(String, StreamEvent), // workspace_id, event

    // --- Chat ---
    ChatInputChanged(String),
    ChatSend,
    ChatMessageSaved(Result<ChatMessage, String>),
    ChatHistoryLoaded(String, Result<Vec<ChatMessage>, String>), // ws_id, result

    // --- Markdown link ---
    ChatLinkClicked(String), // URL

    // --- Diff viewer ---
    ToggleDiffViewer,
    DiffRefresh,
    DiffFilesLoaded(Result<(Vec<DiffFile>, String), String>), // Ok((files, merge_base))
    DiffSelectFile(String),                                   // file path
    DiffFileContentLoaded(Result<FileDiff, String>),
    DiffSetViewMode(DiffViewMode),
    DiffRevertFile(String), // file path
    DiffConfirmRevert,
    DiffCancelRevert,
    DiffFileReverted(Result<String, String>), // Ok(file_path)
}
