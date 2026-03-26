mod chat;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use iced::event;
use iced::keyboard::{self, Key};
use iced::widget::{Row, markdown};
use iced::{Element, Subscription, Task, Theme};
use tokio::sync::Mutex;

use crate::agent::{self, StreamEvent};
use crate::db::Database;
use crate::message::{Message, SidebarFilter};
use crate::model::diff::{DiffFile, DiffViewMode, FileDiff};
use crate::model::{
    AgentStatus, ChatMessage, ChatRole, Repository, TerminalTab, Workspace, WorkspaceStatus,
};
use crate::{diff, git, terminal, ui};

/// Subscription data for an agent stream — hashes only by ws_id for dedup.
#[derive(Clone)]
struct AgentSubData {
    ws_id: String,
    event_rx: Arc<Mutex<Option<tokio::sync::mpsc::Receiver<StreamEvent>>>>,
}

impl Hash for AgentSubData {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.ws_id.hash(state);
    }
}

fn agent_stream(data: &AgentSubData) -> Pin<Box<dyn futures::Stream<Item = Message> + Send>> {
    let rx = data.event_rx.clone();
    let ws_id = data.ws_id.clone();
    Box::pin(futures::stream::unfold(
        (rx, ws_id),
        |(rx, ws_id)| async move {
            // Take receiver out so we don't hold the mutex across recv().await
            let mut receiver = rx.lock().await.take()?;
            let event = receiver.recv().await;
            // Put receiver back for the next iteration
            *rx.lock().await = Some(receiver);
            let event = event?;
            Some((Message::AgentStreamEvent(ws_id.clone(), event), (rx, ws_id)))
        },
    ))
}

/// Handle returned when an agent is spawned — stored on App for communication.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AgentHandle {
    pub stdin_tx: tokio::sync::mpsc::Sender<String>,
    pub event_rx: Arc<Mutex<Option<tokio::sync::mpsc::Receiver<StreamEvent>>>>,
    pub session_id: String,
    pub pid: u32,
}

/// Per-workspace agent state stored on App.
struct AgentState {
    handle: AgentHandle,
    streaming_content: String,
}

pub struct App {
    repositories: Vec<Repository>,
    workspaces: Vec<Workspace>,
    selected_workspace: Option<String>,
    sidebar_visible: bool,
    sidebar_filter: SidebarFilter,
    repo_collapsed: HashMap<String, bool>,

    // Database
    db_path: PathBuf,

    // Add-repo modal
    show_add_repo: bool,
    add_repo_path_input: String,
    add_repo_error: Option<String>,

    // Create-workspace modal
    show_create_workspace: Option<String>, // Some(repo_id)
    create_workspace_name: String,
    create_workspace_error: Option<String>,

    // Re-link repo modal
    show_relink_repo: Option<String>, // Some(repo_id)
    relink_repo_path_input: String,
    relink_repo_error: Option<String>,

    // Repo settings modal
    show_repo_settings: Option<String>, // Some(repo_id)
    repo_settings_name_input: String,
    repo_settings_icon_input: Option<String>,
    repo_settings_error: Option<String>,

    // Icon picker (sub-modal of repo settings)
    show_icon_picker: bool,
    icon_picker_query: String,

    // App settings modal
    show_app_settings: bool,
    app_settings_worktree_base_input: String,
    app_settings_error: Option<String>,
    worktree_base_dir: PathBuf,

    // Delete workspace confirmation
    show_delete_workspace: Option<String>, // Some(ws_id)

    // Remove repository confirmation
    show_remove_repository: Option<String>, // Some(repo_id)
    remove_repo_error: Option<String>,

    // Fuzzy finder
    show_fuzzy_finder: bool,
    fuzzy_query: String,
    fuzzy_selected_index: usize,

    // Agent state per workspace
    agents: HashMap<String, AgentState>,

    // Chat state
    chat_messages: HashMap<String, Vec<ChatMessage>>,
    chat_input: String,
    chat_history_index: Option<usize>,
    chat_history_draft: String,

    // Markdown rendering cache: workspace_id -> vec of parsed items per message
    markdown_cache: HashMap<String, Vec<Vec<markdown::Item>>>,

    // Right sidebar state
    right_sidebar_visible: bool,
    right_sidebar_tab: crate::message::RightSidebarTab,

    // Diff state
    diff_files: Vec<DiffFile>,
    diff_selected_file: Option<String>,
    diff_content: Option<FileDiff>,
    diff_view_mode: DiffViewMode,
    diff_loading: bool,
    diff_error: Option<String>,
    diff_revert_target: Option<String>,
    diff_merge_base: Option<String>,

    // Terminal state
    terminals: HashMap<u64, iced_term::Terminal>,
    terminal_tabs: HashMap<String, Vec<TerminalTab>>,
    active_terminal_tab: HashMap<String, u64>,
    terminal_panel_visible: bool,
    terminal_focused: bool,

    // Panel sizing & drag state
    sidebar_width: f32,
    right_sidebar_width: f32,
    terminal_height: f32,
    dragging_divider: Option<crate::message::DividerDrag>,
    drag_cursor_initialized: bool,
    last_cursor_position: iced::Point,
}

fn claudette_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claudette")
}

fn db_path() -> PathBuf {
    claudette_home().join("claudette.db")
}

impl App {
    pub fn new() -> (Self, Task<Message>) {
        let path = db_path();
        let app = Self {
            repositories: Vec::new(),
            workspaces: Vec::new(),
            selected_workspace: None,
            sidebar_visible: true,
            sidebar_filter: SidebarFilter::All,
            repo_collapsed: HashMap::new(),
            db_path: path.clone(),
            show_add_repo: false,
            add_repo_path_input: String::new(),
            add_repo_error: None,
            show_create_workspace: None,
            create_workspace_name: String::new(),
            create_workspace_error: None,
            show_relink_repo: None,
            relink_repo_path_input: String::new(),
            relink_repo_error: None,
            show_repo_settings: None,
            repo_settings_name_input: String::new(),
            repo_settings_icon_input: None,
            repo_settings_error: None,
            show_icon_picker: false,
            icon_picker_query: String::new(),
            show_app_settings: false,
            app_settings_worktree_base_input: String::new(),
            app_settings_error: None,
            worktree_base_dir: claudette_home().join("workspaces"),
            show_delete_workspace: None,
            show_remove_repository: None,
            remove_repo_error: None,
            show_fuzzy_finder: false,
            fuzzy_query: String::new(),
            fuzzy_selected_index: 0,
            agents: HashMap::new(),
            chat_messages: HashMap::new(),
            chat_input: String::new(),
            chat_history_index: None,
            chat_history_draft: String::new(),
            markdown_cache: HashMap::new(),
            right_sidebar_visible: true,
            right_sidebar_tab: crate::message::RightSidebarTab::Changes,
            diff_files: Vec::new(),
            diff_selected_file: None,
            diff_content: None,
            diff_view_mode: DiffViewMode::Unified,
            diff_loading: false,
            diff_error: None,
            diff_revert_target: None,
            diff_merge_base: None,
            terminals: HashMap::new(),
            terminal_tabs: HashMap::new(),
            active_terminal_tab: HashMap::new(),
            terminal_panel_visible: true,
            terminal_focused: false,
            sidebar_width: ui::style::SIDEBAR_WIDTH,
            right_sidebar_width: ui::style::RIGHT_SIDEBAR_WIDTH,
            terminal_height: 300.0,
            dragging_divider: None,
            drag_cursor_initialized: false,
            last_cursor_position: iced::Point::ORIGIN,
        };

        let load_task = Task::perform(
            async move {
                let db = Database::open(&path).map_err(|e| e.to_string())?;
                let repos = db.list_repositories().map_err(|e| e.to_string())?;
                let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
                let worktree_base = db
                    .get_app_setting("worktree_base_dir")
                    .map_err(|e| e.to_string())?;
                // Seed the terminal ID counter above any existing DB IDs
                let max_id = db.max_terminal_tab_id().map_err(|e| e.to_string())?;
                terminal::seed_next_id(max_id as u64);
                Ok((repos, workspaces, worktree_base))
            },
            Message::DataLoaded,
        );

        let startup = Task::batch([load_task, Task::done(Message::ApplyDockIcon)]);

        (app, startup)
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Noop => {}

            // --- Sidebar ---
            Message::ToggleSidebar => {
                self.sidebar_visible = !self.sidebar_visible;
            }
            Message::SelectWorkspace(id) => {
                self.selected_workspace = Some(id.clone());
                if self.show_fuzzy_finder {
                    self.show_fuzzy_finder = false;
                    self.fuzzy_query.clear();
                }
                self.chat_input.clear();
                self.reset_chat_history();

                // Reset diff state when switching workspaces
                self.diff_files.clear();
                self.diff_selected_file = None;
                self.diff_content = None;
                self.diff_error = None;
                self.diff_merge_base = None;
                self.diff_revert_target = None;

                let mut tasks = vec![];

                // Auto-load changed files for the right sidebar
                if let Some(task) = self.load_diff_files_task() {
                    self.diff_loading = true;
                    tasks.push(task);
                }

                // Load chat history if not already loaded
                if !self.chat_messages.contains_key(&id) {
                    let db_path = self.db_path.clone();
                    let ws_id = id.clone();
                    let ws_id_cb = id.clone();
                    tasks.push(Task::perform(
                        async move {
                            let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                            db.list_chat_messages(&ws_id).map_err(|e| e.to_string())
                        },
                        move |result| Message::ChatHistoryLoaded(ws_id_cb, result),
                    ));
                }

                // Lazily load terminal tabs if not already loaded
                if !self.terminal_tabs.contains_key(&id) {
                    let db_path = self.db_path.clone();
                    let ws_id = id.clone();
                    tasks.push(Task::perform(
                        async move {
                            let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                            db.list_terminal_tabs_by_workspace(&ws_id)
                                .map_err(|e| e.to_string())
                        },
                        {
                            let ws_id = id.clone();
                            move |result| Message::TerminalTabsLoaded(ws_id, result)
                        },
                    ));
                } else if self
                    .terminal_tabs
                    .get(&id)
                    .map(|t| t.is_empty())
                    .unwrap_or(false)
                {
                    // Already loaded but empty — ensure at least 1 terminal exists
                    tasks.push(Task::done(Message::TerminalCreate(id.clone())));
                }

                if !tasks.is_empty() {
                    return Task::batch(tasks);
                }
            }
            Message::ToggleRepoCollapsed(id) => {
                let collapsed = self.repo_collapsed.entry(id).or_insert(false);
                *collapsed = !*collapsed;
            }
            Message::SetSidebarFilter(filter) => {
                self.sidebar_filter = filter;
            }

            // --- Data Loading ---
            Message::DataLoaded(Ok((mut repos, workspaces, worktree_base))) => {
                for repo in &mut repos {
                    repo.path_valid = std::path::Path::new(&repo.path).join(".git").exists();
                }
                self.repositories = repos;
                self.workspaces = workspaces;
                if let Some(base) = worktree_base {
                    self.worktree_base_dir = PathBuf::from(base);
                }
            }
            Message::DataLoaded(Err(e)) => {
                eprintln!("Failed to load data from database: {e}");
            }

            // --- Add Repository ---
            Message::ShowAddRepo => {
                self.show_add_repo = true;
                self.add_repo_path_input.clear();
                self.add_repo_error = None;
            }
            Message::HideAddRepo => {
                self.show_add_repo = false;
            }
            Message::AddRepoPathChanged(value) => {
                self.add_repo_path_input = value;
                self.add_repo_error = None;
            }
            Message::BrowseRepoPath => {
                return Task::perform(
                    async {
                        rfd::AsyncFileDialog::new()
                            .set_title("Select Repository")
                            .pick_folder()
                            .await
                            .map(|h| h.path().to_string_lossy().to_string())
                    },
                    Message::RepoPathSelected,
                );
            }
            Message::RepoPathSelected(Some(path)) => {
                self.add_repo_path_input = path;
                self.add_repo_error = None;
            }
            Message::RepoPathSelected(None) => {}
            Message::ConfirmAddRepo => {
                let path = self.add_repo_path_input.trim().to_string();

                if self.repositories.iter().any(|r| r.path == path) {
                    self.add_repo_error = Some("Repository already added".into());
                    return Task::none();
                }

                let db_path = self.db_path.clone();
                return Task::perform(
                    async move {
                        crate::git::validate_repo(&path)
                            .await
                            .map_err(|e| e.to_string())?;

                        let name = std::path::Path::new(&path)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| path.clone());

                        let path_slug = name.clone();
                        let repo = Repository {
                            id: uuid::Uuid::new_v4().to_string(),
                            path,
                            name,
                            path_slug,
                            icon: None,
                            created_at: String::new(),
                            path_valid: true,
                        };

                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.insert_repository(&repo).map_err(|e| e.to_string())?;
                        Ok(repo)
                    },
                    Message::RepoAdded,
                );
            }
            Message::RepoAdded(Ok(repo)) => {
                self.repositories.push(repo);
                self.show_add_repo = false;
                self.add_repo_path_input.clear();
                self.add_repo_error = None;
            }
            Message::RepoAdded(Err(msg)) => {
                self.add_repo_error = Some(msg);
            }

            // --- Remove Repository (with confirmation) ---
            Message::ShowRemoveRepository(repo_id) => {
                // Close settings modal if the user clicked "Remove" from there
                self.show_repo_settings = None;
                self.remove_repo_error = None;
                self.show_remove_repository = Some(repo_id);
            }
            Message::HideRemoveRepository => {
                self.show_remove_repository = None;
            }
            Message::ConfirmRemoveRepository => {
                let Some(repo_id) = self.show_remove_repository.clone() else {
                    return Task::none();
                };
                self.remove_repo_error = None;

                // Stop all running agents for this repo's workspaces
                let ws_ids: Vec<String> = self
                    .workspaces
                    .iter()
                    .filter(|w| w.repository_id == repo_id)
                    .map(|w| w.id.clone())
                    .collect();

                for ws_id in &ws_ids {
                    if let Some(state) = self.agents.remove(ws_id) {
                        let pid = state.handle.pid;
                        tokio::spawn(async move {
                            let _ = agent::stop_agent(pid).await;
                        });
                    }
                }

                // Collect worktree paths and repo path for async cleanup
                let worktree_paths: Vec<String> = self
                    .workspaces
                    .iter()
                    .filter(|w| w.repository_id == repo_id)
                    .filter_map(|w| w.worktree_path.clone())
                    .collect();

                let repo = self.repositories.iter().find(|r| r.id == repo_id).cloned();
                let Some(repo) = repo else {
                    return Task::none();
                };
                let db_path = self.db_path.clone();
                let repo_path = repo.path.clone();

                return Task::perform(
                    async move {
                        // Remove all worktree directories
                        for wt_path in &worktree_paths {
                            crate::git::remove_worktree(&repo_path, wt_path).await.ok();
                        }
                        // Delete from DB (cascades to workspaces, chat_messages, terminal_tabs)
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.delete_repository(&repo_id).map_err(|e| e.to_string())?;
                        Ok(repo_id)
                    },
                    Message::RepositoryRemoved,
                );
            }
            Message::RepositoryRemoved(Ok(repo_id)) => {
                // Dismiss confirmation modal
                self.show_remove_repository = None;

                // Collect workspace IDs before removing them
                let ws_ids: Vec<String> = self
                    .workspaces
                    .iter()
                    .filter(|w| w.repository_id == repo_id)
                    .map(|w| w.id.clone())
                    .collect();

                // Drain any agents (catches late spawns that arrived after Confirm)
                for ws_id in &ws_ids {
                    if let Some(state) = self.agents.remove(ws_id) {
                        let pid = state.handle.pid;
                        tokio::spawn(async move {
                            let _ = agent::stop_agent(pid).await;
                        });
                    }
                }

                // Clean up per-workspace in-memory state
                for ws_id in &ws_ids {
                    self.chat_messages.remove(ws_id);
                    self.markdown_cache.remove(ws_id);
                    if let Some(tabs) = self.terminal_tabs.remove(ws_id) {
                        for tab in &tabs {
                            self.terminals.remove(&(tab.id as u64));
                        }
                    }
                    self.active_terminal_tab.remove(ws_id);
                }

                // Remove workspaces and repository
                self.workspaces.retain(|w| w.repository_id != repo_id);
                self.repositories.retain(|r| r.id != repo_id);
                self.repo_collapsed.remove(&repo_id);

                // Clear selection if it pointed to a removed workspace
                if let Some(sel) = &self.selected_workspace
                    && !self.workspaces.iter().any(|w| w.id == *sel)
                {
                    self.selected_workspace = None;
                }
            }
            Message::RepositoryRemoved(Err(e)) => {
                eprintln!("Failed to remove repository: {e}");
                self.remove_repo_error = Some(format!("Failed to remove repository: {e}"));
            }

            // --- Re-link Repository ---
            Message::ShowRelinkRepo(repo_id) => {
                let current_path = self
                    .repositories
                    .iter()
                    .find(|r| r.id == repo_id)
                    .map(|r| r.path.clone())
                    .unwrap_or_default();
                self.show_relink_repo = Some(repo_id);
                self.relink_repo_path_input = current_path;
                self.relink_repo_error = None;
            }
            Message::HideRelinkRepo => {
                self.show_relink_repo = None;
            }
            Message::RelinkRepoPathChanged(value) => {
                self.relink_repo_path_input = value;
                self.relink_repo_error = None;
            }
            Message::BrowseRelinkPath => {
                return Task::perform(
                    async {
                        rfd::AsyncFileDialog::new()
                            .set_title("Select Repository")
                            .pick_folder()
                            .await
                            .map(|h| h.path().to_string_lossy().to_string())
                    },
                    Message::RelinkPathSelected,
                );
            }
            Message::RelinkPathSelected(Some(path)) => {
                self.relink_repo_path_input = path;
                self.relink_repo_error = None;
            }
            Message::RelinkPathSelected(None) => {}
            Message::ConfirmRelinkRepo => {
                let Some(repo_id) = self.show_relink_repo.clone() else {
                    return Task::none();
                };
                let path = self.relink_repo_path_input.trim().to_string();
                let db_path = self.db_path.clone();

                return Task::perform(
                    async move {
                        crate::git::validate_repo(&path)
                            .await
                            .map_err(|e| e.to_string())?;
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.update_repository_path(&repo_id, &path)
                            .map_err(|e| e.to_string())?;
                        Ok((repo_id, path))
                    },
                    Message::RepoRelinked,
                );
            }
            Message::RepoRelinked(Ok((repo_id, new_path))) => {
                if let Some(repo) = self.repositories.iter_mut().find(|r| r.id == repo_id) {
                    repo.path = new_path;
                    repo.path_valid = true;
                }
                self.show_relink_repo = None;
            }
            Message::RepoRelinked(Err(msg)) => {
                self.relink_repo_error = Some(msg);
            }

            // --- Create Workspace ---
            Message::ShowCreateWorkspace(repo_id) => {
                let namer = crate::names::NameGenerator::new();
                let generated = namer.generate();
                self.show_create_workspace = Some(repo_id);
                self.create_workspace_name = format!("{}-{}", generated.adjective, generated.plant);
                self.create_workspace_error = None;
            }
            Message::HideCreateWorkspace => {
                self.show_create_workspace = None;
            }
            Message::CreateWorkspaceNameChanged(name) => {
                self.create_workspace_name = name;
                self.create_workspace_error = None;
            }
            Message::RegenerateWorkspaceName => {
                let namer = crate::names::NameGenerator::new();
                let generated = namer.generate();
                self.create_workspace_name = format!("{}-{}", generated.adjective, generated.plant);
                self.create_workspace_error = None;
            }
            Message::ConfirmCreateWorkspace => {
                let Some(repo_id) = self.show_create_workspace.clone() else {
                    return Task::none();
                };
                let ws_name = self.create_workspace_name.trim().to_string();

                if ws_name.is_empty() {
                    self.create_workspace_error = Some("Name cannot be empty".into());
                    return Task::none();
                }

                if ws_name.contains('/')
                    || ws_name.contains('\\')
                    || ws_name.contains("..")
                    || ws_name.contains(' ')
                    || ws_name.contains('~')
                    || ws_name.contains(':')
                    || ws_name.contains('?')
                    || ws_name.contains('*')
                    || ws_name.contains('[')
                    || ws_name.starts_with('.')
                    || ws_name.ends_with('.')
                    || ws_name.ends_with(".lock")
                {
                    self.create_workspace_error = Some(
                        "Invalid name: avoid /, \\, .., spaces, and special characters".into(),
                    );
                    return Task::none();
                }

                if self
                    .workspaces
                    .iter()
                    .any(|w| w.repository_id == repo_id && w.name == ws_name)
                {
                    self.create_workspace_error =
                        Some("Workspace with this name already exists".into());
                    return Task::none();
                }

                let repo = self.repositories.iter().find(|r| r.id == repo_id).cloned();
                let Some(repo) = repo else {
                    return Task::none();
                };

                let db_path = self.db_path.clone();
                let branch_name = format!("claudette/{ws_name}");

                let worktree_path = self.worktree_base_dir.join(&repo.path_slug).join(&ws_name);
                let worktree_path_str = worktree_path.to_string_lossy().to_string();

                return Task::perform(
                    async move {
                        let wt_path = crate::git::create_worktree(
                            &repo.path,
                            &branch_name,
                            &worktree_path_str,
                        )
                        .await
                        .map_err(|e| e.to_string())?;

                        let ws = Workspace {
                            id: uuid::Uuid::new_v4().to_string(),
                            repository_id: repo.id.clone(),
                            name: ws_name,
                            branch_name,
                            worktree_path: Some(wt_path),
                            status: WorkspaceStatus::Active,
                            agent_status: AgentStatus::Idle,
                            status_line: String::new(),
                            created_at: String::new(),
                        };

                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.insert_workspace(&ws).map_err(|e| e.to_string())?;
                        Ok(ws)
                    },
                    Message::WorkspaceCreated,
                );
            }
            Message::WorkspaceCreated(Ok(ws)) => {
                let ws_id = ws.id.clone();
                self.workspaces.push(ws);
                self.selected_workspace = Some(ws_id.clone());
                self.show_create_workspace = None;
                return Task::done(Message::TerminalCreate(ws_id));
            }
            Message::WorkspaceCreated(Err(msg)) => {
                self.create_workspace_error = Some(msg);
            }

            // --- Archive ---
            Message::ArchiveWorkspace(ws_id) => {
                // Destroy all terminals for this workspace
                if let Some(tabs) = self.terminal_tabs.remove(&ws_id) {
                    for tab in &tabs {
                        self.terminals.remove(&(tab.id as u64));
                    }
                }
                self.active_terminal_tab.remove(&ws_id);

                // Stop agent first if running
                if self.agents.contains_key(&ws_id) {
                    let pid = self.agents[&ws_id].handle.pid;
                    self.agents.remove(&ws_id);
                    if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) {
                        ws.agent_status = AgentStatus::Idle;
                    }
                    tokio::spawn(async move {
                        let _ = agent::stop_agent(pid).await;
                    });
                }

                let ws = self.workspaces.iter().find(|w| w.id == ws_id).cloned();
                let Some(ws) = ws else {
                    return Task::none();
                };
                let repo = self
                    .repositories
                    .iter()
                    .find(|r| r.id == ws.repository_id)
                    .cloned();
                let Some(repo) = repo else {
                    return Task::none();
                };
                let db_path = self.db_path.clone();

                return Task::perform(
                    async move {
                        if let Some(wt_path) = &ws.worktree_path {
                            crate::git::remove_worktree(&repo.path, wt_path)
                                .await
                                .map_err(|e| e.to_string())?;
                        }
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.delete_terminal_tabs_for_workspace(&ws.id)
                            .map_err(|e| e.to_string())?;
                        db.update_workspace_status(&ws.id, &WorkspaceStatus::Archived, None)
                            .map_err(|e| e.to_string())?;
                        Ok(ws.id)
                    },
                    Message::WorkspaceArchived,
                );
            }
            Message::WorkspaceArchived(Ok(ws_id)) => {
                if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) {
                    ws.status = WorkspaceStatus::Archived;
                    ws.worktree_path = None;
                    ws.agent_status = AgentStatus::Stopped;
                }
            }
            Message::WorkspaceArchived(Err(e)) => {
                eprintln!("Failed to archive workspace: {e}");
            }

            // --- Restore ---
            Message::RestoreWorkspace(ws_id) => {
                let ws = self.workspaces.iter().find(|w| w.id == ws_id).cloned();
                let Some(ws) = ws else {
                    return Task::none();
                };
                let repo = self
                    .repositories
                    .iter()
                    .find(|r| r.id == ws.repository_id)
                    .cloned();
                let Some(repo) = repo else {
                    return Task::none();
                };
                let db_path = self.db_path.clone();

                let worktree_path = self.worktree_base_dir.join(&repo.path_slug).join(&ws.name);
                let worktree_path_str = worktree_path.to_string_lossy().to_string();

                return Task::perform(
                    async move {
                        let wt_path = crate::git::restore_worktree(
                            &repo.path,
                            &ws.branch_name,
                            &worktree_path_str,
                        )
                        .await
                        .map_err(|e| e.to_string())?;

                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.update_workspace_status(
                            &ws.id,
                            &WorkspaceStatus::Active,
                            Some(&wt_path),
                        )
                        .map_err(|e| e.to_string())?;
                        Ok((ws.id, wt_path))
                    },
                    Message::WorkspaceRestored,
                );
            }
            Message::WorkspaceRestored(Ok((ws_id, wt_path))) => {
                if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) {
                    ws.status = WorkspaceStatus::Active;
                    ws.worktree_path = Some(wt_path);
                    ws.agent_status = AgentStatus::Idle;
                }
                return Task::done(Message::TerminalCreate(ws_id));
            }
            Message::WorkspaceRestored(Err(e)) => {
                eprintln!("Failed to restore workspace: {e}");
            }

            // --- Delete ---
            Message::DeleteWorkspace(ws_id) => {
                self.show_delete_workspace = Some(ws_id);
            }
            Message::HideDeleteWorkspace => {
                self.show_delete_workspace = None;
            }
            Message::ConfirmDeleteWorkspace => {
                let Some(ws_id) = self.show_delete_workspace.take() else {
                    return Task::none();
                };

                // Stop agent if running
                if let Some(state) = self.agents.remove(&ws_id) {
                    let pid = state.handle.pid;
                    tokio::spawn(async move {
                        let _ = agent::stop_agent(pid).await;
                    });
                }

                let ws = self.workspaces.iter().find(|w| w.id == ws_id).cloned();
                let Some(ws) = ws else {
                    return Task::none();
                };
                let repo = self
                    .repositories
                    .iter()
                    .find(|r| r.id == ws.repository_id)
                    .cloned();
                let Some(repo) = repo else {
                    return Task::none();
                };
                let db_path = self.db_path.clone();

                return Task::perform(
                    async move {
                        if let Some(wt_path) = &ws.worktree_path {
                            crate::git::remove_worktree(&repo.path, wt_path).await.ok();
                        }
                        crate::git::branch_delete(&repo.path, &ws.branch_name)
                            .await
                            .ok();
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.delete_workspace(&ws.id).map_err(|e| e.to_string())?;
                        Ok(ws.id)
                    },
                    Message::WorkspaceDeleted,
                );
            }
            Message::WorkspaceDeleted(Ok(ws_id)) => {
                self.workspaces.retain(|w| w.id != ws_id);
                self.chat_messages.remove(&ws_id);
                self.markdown_cache.remove(&ws_id);
                if let Some(tabs) = self.terminal_tabs.remove(&ws_id) {
                    for tab in &tabs {
                        self.terminals.remove(&(tab.id as u64));
                    }
                }
                self.active_terminal_tab.remove(&ws_id);
                if self.selected_workspace.as_deref() == Some(&ws_id) {
                    self.selected_workspace = None;
                }
            }
            Message::WorkspaceDeleted(Err(e)) => {
                eprintln!("Failed to delete workspace: {e}");
            }

            // --- Fuzzy Finder ---
            Message::ToggleFuzzyFinder => {
                self.show_fuzzy_finder = !self.show_fuzzy_finder;
                self.fuzzy_query.clear();
                self.fuzzy_selected_index = 0;
            }
            Message::FuzzyQueryChanged(query) => {
                self.fuzzy_query = query;
                self.fuzzy_selected_index = 0;
            }
            Message::FuzzyNavigateUp => {
                if self.fuzzy_selected_index > 0 {
                    self.fuzzy_selected_index -= 1;
                }
            }
            Message::FuzzyNavigateDown => {
                let count = self.fuzzy_filtered_workspaces().count();
                if self.fuzzy_selected_index + 1 < count {
                    self.fuzzy_selected_index += 1;
                }
            }
            Message::FuzzyConfirm => {
                let selected: Vec<_> = self.fuzzy_filtered_workspaces().collect();
                if let Some(ws) = selected.get(self.fuzzy_selected_index) {
                    self.selected_workspace = Some(ws.id.clone());
                }
                self.show_fuzzy_finder = false;
                self.fuzzy_query.clear();
            }

            // --- Repository settings ---
            Message::ShowRepoSettings(repo_id) => {
                if let Some(repo) = self.repositories.iter().find(|r| r.id == repo_id) {
                    self.repo_settings_name_input = repo.name.clone();
                    self.repo_settings_icon_input = repo.icon.clone();
                    self.repo_settings_error = None;
                    self.show_repo_settings = Some(repo_id);
                }
            }
            Message::HideRepoSettings => {
                self.show_repo_settings = None;
                self.show_icon_picker = false;
                self.repo_settings_error = None;
            }
            Message::RepoSettingsNameChanged(name) => {
                self.repo_settings_name_input = name;
                self.repo_settings_error = None;
            }
            Message::ShowIconPicker => {
                self.show_icon_picker = true;
                self.icon_picker_query.clear();
            }
            Message::HideIconPicker => {
                self.show_icon_picker = false;
            }
            Message::IconPickerQueryChanged(query) => {
                self.icon_picker_query = query;
            }
            Message::SelectIcon(icon) => {
                self.repo_settings_icon_input = icon;
                self.show_icon_picker = false;
            }
            Message::ConfirmRepoSettings => {
                let Some(repo_id) = self.show_repo_settings.clone() else {
                    return Task::none();
                };
                let name = self.repo_settings_name_input.trim().to_string();
                if name.is_empty() {
                    self.repo_settings_error = Some("Name cannot be empty".into());
                    return Task::none();
                }
                let icon = self.repo_settings_icon_input.clone();
                let db_path = self.db_path.clone();

                return Task::perform(
                    async move {
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.update_repository_name(&repo_id, &name)
                            .map_err(|e| e.to_string())?;
                        db.update_repository_icon(&repo_id, icon.as_deref())
                            .map_err(|e| e.to_string())?;
                        Ok((repo_id, name, icon))
                    },
                    Message::RepoSettingsUpdated,
                );
            }
            Message::RepoSettingsUpdated(Ok((repo_id, name, icon))) => {
                if let Some(repo) = self.repositories.iter_mut().find(|r| r.id == repo_id) {
                    repo.name = name;
                    repo.icon = icon;
                }
                self.show_repo_settings = None;
                self.show_icon_picker = false;
                self.repo_settings_error = None;
            }
            Message::RepoSettingsUpdated(Err(e)) => {
                self.repo_settings_error = Some(e);
            }

            // --- App settings ---
            Message::ShowAppSettings => {
                self.app_settings_worktree_base_input =
                    self.worktree_base_dir.to_string_lossy().to_string();
                self.app_settings_error = None;
                self.show_app_settings = true;
            }
            Message::HideAppSettings => {
                self.show_app_settings = false;
                self.app_settings_error = None;
            }
            Message::AppSettingsWorktreeBaseChanged(path) => {
                self.app_settings_worktree_base_input = path;
                self.app_settings_error = None;
            }
            Message::BrowseWorktreeBase => {
                return Task::perform(
                    async {
                        rfd::AsyncFileDialog::new()
                            .set_title("Choose worktree base directory")
                            .pick_folder()
                            .await
                            .map(|h| h.path().to_string_lossy().to_string())
                    },
                    Message::WorktreeBaseSelected,
                );
            }
            Message::WorktreeBaseSelected(Some(path)) => {
                self.app_settings_worktree_base_input = path;
                self.app_settings_error = None;
            }
            Message::WorktreeBaseSelected(None) => {}
            Message::ConfirmAppSettings => {
                let path = self.app_settings_worktree_base_input.trim().to_string();
                if path.is_empty() {
                    self.app_settings_error = Some("Path cannot be empty".into());
                    return Task::none();
                }
                let db_path = self.db_path.clone();
                return Task::perform(
                    async move {
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.set_app_setting("worktree_base_dir", &path)
                            .map_err(|e| e.to_string())?;
                        Ok(path)
                    },
                    Message::AppSettingsUpdated,
                );
            }
            Message::AppSettingsUpdated(Ok(path)) => {
                self.worktree_base_dir = PathBuf::from(path);
                self.show_app_settings = false;
                self.app_settings_error = None;
            }
            Message::AppSettingsUpdated(Err(e)) => {
                self.app_settings_error = Some(e);
            }

            // --- App lifecycle ---
            Message::ApplyDockIcon => {
                set_dock_icon();
            }

            // --- Escape ---
            Message::EscapePressed => {
                if self.show_icon_picker {
                    self.show_icon_picker = false;
                } else if self.show_repo_settings.is_some() {
                    self.show_repo_settings = None;
                } else if self.show_app_settings {
                    self.show_app_settings = false;
                } else if self.diff_revert_target.is_some() {
                    self.diff_revert_target = None;
                } else if self.show_fuzzy_finder {
                    self.show_fuzzy_finder = false;
                } else if self.diff_selected_file.is_some() {
                    self.diff_selected_file = None;
                    self.diff_content = None;
                } else if self.show_delete_workspace.is_some() {
                    self.show_delete_workspace = None;
                } else if self.show_remove_repository.is_some() {
                    self.show_remove_repository = None;
                } else if self.show_relink_repo.is_some() {
                    self.show_relink_repo = None;
                } else if self.show_create_workspace.is_some() {
                    self.show_create_workspace = None;
                } else if self.show_add_repo {
                    self.show_add_repo = false;
                }
            }

            // --- Agent Lifecycle ---
            Message::AgentStart(ws_id) => {
                let ws = self.workspaces.iter().find(|w| w.id == ws_id).cloned();
                let Some(ws) = ws else {
                    return Task::none();
                };
                let Some(worktree_path) = ws.worktree_path.clone() else {
                    return Task::none();
                };

                if let Some(w) = self.workspaces.iter_mut().find(|w| w.id == ws_id) {
                    w.agent_status = AgentStatus::Running;
                }

                let session_id = uuid::Uuid::new_v4().to_string();

                return Task::perform(
                    async move {
                        let spawned =
                            agent::spawn_agent(std::path::Path::new(&worktree_path), &session_id)
                                .await?;

                        let handle = AgentHandle {
                            stdin_tx: spawned.stdin_tx,
                            event_rx: Arc::new(Mutex::new(Some(spawned.event_rx))),
                            session_id: spawned.session_id,
                            pid: spawned.pid,
                        };

                        Ok((ws_id, handle))
                    },
                    Message::AgentSpawned,
                );
            }
            Message::AgentSpawned(Ok((ws_id, handle))) => {
                // Guard: if the workspace was removed while spawning, kill the orphan
                if !self.workspaces.iter().any(|w| w.id == ws_id) {
                    let pid = handle.pid;
                    tokio::spawn(async move {
                        let _ = agent::stop_agent(pid).await;
                    });
                    return Task::none();
                }

                // Add system message
                let sys_msg = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: ws_id.clone(),
                    role: ChatRole::System,
                    content: "Agent started".into(),
                    cost_usd: None,
                    duration_ms: None,
                    created_at: String::new(),
                };
                self.chat_messages
                    .entry(ws_id.clone())
                    .or_default()
                    .push(sys_msg.clone());
                self.rebuild_markdown_cache(&ws_id);

                // Persist system message
                let db_path = self.db_path.clone();
                let persist_task = Task::perform(
                    async move {
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.insert_chat_message(&sys_msg)
                            .map_err(|e| e.to_string())?;
                        Ok(sys_msg)
                    },
                    Message::ChatMessageSaved,
                );

                self.agents.insert(
                    ws_id,
                    AgentState {
                        handle,
                        streaming_content: String::new(),
                    },
                );

                return persist_task;
            }
            Message::AgentSpawned(Err(e)) => {
                eprintln!("Failed to spawn agent: {e}");
                // Reset any workspaces still marked as Running back to Error
                let running: Vec<_> = self
                    .workspaces
                    .iter()
                    .filter(|w| matches!(w.agent_status, AgentStatus::Running))
                    .map(|w| w.id.clone())
                    .collect();
                for ws_id in &running {
                    if let Some(ws) = self.workspaces.iter_mut().find(|w| &w.id == ws_id) {
                        ws.agent_status = AgentStatus::Error(e.clone());
                    }
                    let sys_msg = ChatMessage {
                        id: uuid::Uuid::new_v4().to_string(),
                        workspace_id: ws_id.clone(),
                        role: ChatRole::System,
                        content: format!("Failed to start agent: {e}"),
                        cost_usd: None,
                        duration_ms: None,
                        created_at: String::new(),
                    };
                    self.chat_messages
                        .entry(ws_id.clone())
                        .or_default()
                        .push(sys_msg);
                    self.rebuild_markdown_cache(ws_id);
                }
            }

            Message::AgentStop(ws_id) => {
                if let Some(state) = self.agents.remove(&ws_id) {
                    let pid = state.handle.pid;
                    if let Some(ws) = self.workspaces.iter_mut().find(|w| w.id == ws_id) {
                        ws.agent_status = AgentStatus::Idle;
                    }

                    // Add system message
                    let sys_msg = ChatMessage {
                        id: uuid::Uuid::new_v4().to_string(),
                        workspace_id: ws_id.clone(),
                        role: ChatRole::System,
                        content: "Agent stopped".into(),
                        cost_usd: None,
                        duration_ms: None,
                        created_at: String::new(),
                    };
                    self.chat_messages
                        .entry(ws_id.clone())
                        .or_default()
                        .push(sys_msg.clone());
                    self.rebuild_markdown_cache(&ws_id);

                    let db_path = self.db_path.clone();
                    return Task::batch([
                        Task::perform(async move { agent::stop_agent(pid).await }, move |result| {
                            Message::AgentStopped(result.map(|()| ws_id.clone()))
                        }),
                        Task::perform(
                            async move {
                                let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                                db.insert_chat_message(&sys_msg)
                                    .map_err(|e| e.to_string())?;
                                Ok(sys_msg)
                            },
                            Message::ChatMessageSaved,
                        ),
                    ]);
                }
            }
            Message::AgentStopped(Ok(_ws_id)) => {
                // Agent already removed from self.agents in AgentStop
            }
            Message::AgentStopped(Err(e)) => {
                eprintln!("Failed to stop agent: {e}");
            }

            // --- Agent Stream Events ---
            Message::AgentStreamEvent(ws_id, event) => {
                return self.handle_stream_event(&ws_id, event);
            }

            // --- Chat ---
            Message::ChatInputChanged(text) => {
                self.terminal_focused = false;
                self.handle_chat_input_changed(text);
            }
            Message::ChatSend => {
                return self.handle_chat_send();
            }
            Message::ChatMessageSaved(result) => {
                self.handle_chat_message_saved(result);
            }
            Message::ChatHistoryLoaded(ws_id, result) => {
                self.handle_chat_history_loaded(ws_id, result);
            }
            Message::ChatHistoryUp => {
                self.handle_chat_history_up();
            }
            Message::ChatHistoryDown => {
                self.handle_chat_history_down();
            }

            // --- Markdown link ---
            Message::ChatLinkClicked(url) => {
                self.handle_chat_link_clicked(&url);
            }

            // --- Right sidebar / Diff ---
            Message::ToggleRightSidebar => {
                self.right_sidebar_visible = !self.right_sidebar_visible;
                // Auto-load changed files when opening if empty
                if self.right_sidebar_visible
                    && self.diff_files.is_empty()
                    && let Some(task) = self.load_diff_files_task()
                {
                    self.diff_loading = true;
                    return task;
                }
            }
            Message::SetRightSidebarTab(tab) => {
                self.right_sidebar_tab = tab;
            }
            Message::DiffClearSelection => {
                self.diff_selected_file = None;
                self.diff_content = None;
            }
            Message::DiffRefresh => {
                self.diff_files.clear();
                self.diff_selected_file = None;
                self.diff_content = None;
                self.diff_error = None;
                self.diff_merge_base = None;
                if let Some(task) = self.load_diff_files_task() {
                    self.diff_loading = true;
                    return task;
                }
            }
            Message::DiffFilesLoaded(Ok((files, merge_base))) => {
                self.diff_loading = false;
                self.diff_error = None;
                self.diff_merge_base = Some(merge_base);

                let first_file = files.first().map(|f| f.path.clone());
                self.diff_files = files;

                if let Some(path) = first_file {
                    return Task::done(Message::DiffSelectFile(path));
                }
            }
            Message::DiffFilesLoaded(Err(e)) => {
                self.diff_loading = false;
                self.diff_error = Some(e);
            }
            Message::DiffSelectFile(path) => {
                self.diff_selected_file = Some(path.clone());
                self.diff_content = None;
                self.diff_error = None;
                self.diff_loading = true;

                let Some(ws_id) = self.selected_workspace.clone() else {
                    return Task::none();
                };
                let ws = self.workspaces.iter().find(|w| w.id == ws_id).cloned();
                let Some(ws) = ws else {
                    return Task::none();
                };
                let Some(worktree_path) = ws.worktree_path.clone() else {
                    return Task::none();
                };
                let Some(merge_base) = self.diff_merge_base.clone() else {
                    return Task::none();
                };

                return Task::perform(
                    async move {
                        let raw = diff::file_diff(&worktree_path, &merge_base, &path)
                            .await
                            .map_err(|e| e.to_string())?;
                        Ok(diff::parse_unified_diff(&raw, &path))
                    },
                    Message::DiffFileContentLoaded,
                );
            }
            Message::DiffFileContentLoaded(Ok(file_diff)) => {
                // Guard against out-of-order responses: only update if the loaded
                // diff still matches the currently selected file
                if self.diff_selected_file.as_ref() == Some(&file_diff.path) {
                    self.diff_loading = false;
                    self.diff_error = None;
                    self.diff_content = Some(file_diff);
                }
            }
            Message::DiffFileContentLoaded(Err(e)) => {
                self.diff_loading = false;
                self.diff_error = Some(e);
            }
            Message::DiffSetViewMode(mode) => {
                self.diff_view_mode = mode;
            }
            Message::DiffRevertFile(path) => {
                self.diff_revert_target = Some(path);
            }
            Message::DiffCancelRevert => {
                self.diff_revert_target = None;
            }
            Message::DiffConfirmRevert => {
                let Some(file_path) = self.diff_revert_target.take() else {
                    return Task::none();
                };
                let Some(ws_id) = self.selected_workspace.clone() else {
                    return Task::none();
                };
                let ws = self.workspaces.iter().find(|w| w.id == ws_id).cloned();
                let Some(ws) = ws else {
                    return Task::none();
                };
                let Some(worktree_path) = ws.worktree_path.clone() else {
                    return Task::none();
                };
                let Some(merge_base) = self.diff_merge_base.clone() else {
                    return Task::none();
                };

                let status = self
                    .diff_files
                    .iter()
                    .find(|f| f.path == file_path)
                    .map(|f| f.status.clone());
                let Some(status) = status else {
                    return Task::none();
                };

                let path_clone = file_path.clone();
                return Task::perform(
                    async move {
                        diff::revert_file(&worktree_path, &merge_base, &path_clone, &status)
                            .await
                            .map_err(|e| e.to_string())?;
                        Ok(path_clone)
                    },
                    Message::DiffFileReverted,
                );
            }
            Message::DiffFileReverted(Ok(path)) => {
                self.diff_files.retain(|f| f.path != path);
                if self.diff_selected_file.as_deref() == Some(&path) {
                    self.diff_selected_file = None;
                    self.diff_content = None;
                    // Auto-select next file
                    if let Some(next) = self.diff_files.first() {
                        return Task::done(Message::DiffSelectFile(next.path.clone()));
                    }
                }
            }
            Message::DiffFileReverted(Err(e)) => {
                self.diff_error = Some(format!("Failed to revert: {e}"));
            }

            // --- Terminal ---
            Message::TerminalCreate(ws_id) => {
                let ws = self.workspaces.iter().find(|w| w.id == ws_id);
                let Some(wt_path) = ws.and_then(|w| w.worktree_path.as_deref()) else {
                    return Task::none();
                };

                let id = terminal::next_terminal_id();
                match terminal::create_terminal(id, std::path::Path::new(wt_path)) {
                    Ok(term) => {
                        self.terminals.insert(id, term);
                        let sort_order = self
                            .terminal_tabs
                            .get(&ws_id)
                            .and_then(|tabs| tabs.iter().map(|t| t.sort_order).max())
                            .map(|max| max + 1)
                            .unwrap_or(0);
                        let tab = TerminalTab {
                            id: id as i64,
                            workspace_id: ws_id.clone(),
                            title: format!("Terminal {}", sort_order + 1),
                            is_script_output: false,
                            sort_order,
                            created_at: String::new(),
                        };
                        self.terminal_tabs
                            .entry(ws_id.clone())
                            .or_default()
                            .push(tab.clone());
                        self.active_terminal_tab.insert(ws_id.clone(), id);

                        // Focus chat input to unfocus the new terminal so it
                        // doesn't capture keystrokes meant for other widgets
                        self.terminal_focused = false;
                        let focus_chat =
                            iced::widget::operation::focus(ui::chat_panel::chat_input_id());
                        let db_path = self.db_path.clone();
                        let persist = Task::perform(
                            async move {
                                let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                                db.insert_terminal_tab(&tab).map_err(|e| e.to_string())?;
                                Ok((ws_id, tab))
                            },
                            Message::TerminalCreated,
                        );
                        return Task::batch([persist, focus_chat]);
                    }
                    Err(e) => {
                        eprintln!("Failed to create terminal: {e}");
                    }
                }
            }
            Message::TerminalCreated(Ok(_)) => {}
            Message::TerminalCreated(Err(e)) => {
                eprintln!("Failed to persist terminal tab: {e}");
            }

            Message::TerminalClose(terminal_id) => {
                self.terminals.remove(&terminal_id);
                let tab_id = terminal_id as i64;
                let mut affected_ws = None;
                for (ws_id, tabs) in &mut self.terminal_tabs {
                    if let Some(pos) = tabs.iter().position(|t| t.id == tab_id) {
                        tabs.remove(pos);
                        affected_ws = Some(ws_id.clone());
                        break;
                    }
                }
                if let Some(ws_id) = &affected_ws
                    && self.active_terminal_tab.get(ws_id) == Some(&terminal_id)
                {
                    let new_active = self
                        .terminal_tabs
                        .get(ws_id)
                        .and_then(|tabs| tabs.first())
                        .map(|t| t.id as u64);
                    if let Some(id) = new_active {
                        self.active_terminal_tab.insert(ws_id.clone(), id);
                    } else {
                        self.active_terminal_tab.remove(ws_id);
                    }
                }

                // Auto-recreate if last terminal was closed
                if let Some(ws_id) = &affected_ws {
                    let is_empty = self
                        .terminal_tabs
                        .get(ws_id)
                        .map(|t| t.is_empty())
                        .unwrap_or(true);
                    if is_empty {
                        let ws_id = ws_id.clone();
                        let db_path = self.db_path.clone();
                        return Task::batch([
                            Task::perform(
                                async move {
                                    let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                                    db.delete_terminal_tab(tab_id).map_err(|e| e.to_string())?;
                                    Ok(tab_id)
                                },
                                Message::TerminalClosed,
                            ),
                            Task::done(Message::TerminalCreate(ws_id)),
                        ]);
                    }
                }

                let db_path = self.db_path.clone();
                return Task::perform(
                    async move {
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.delete_terminal_tab(tab_id).map_err(|e| e.to_string())?;
                        Ok(tab_id)
                    },
                    Message::TerminalClosed,
                );
            }
            Message::TerminalClosed(Ok(_)) => {}
            Message::TerminalClosed(Err(e)) => {
                eprintln!("Failed to delete terminal tab: {e}");
            }

            Message::TerminalSelectTab(terminal_id) => {
                if let Some(ws_id) = &self.selected_workspace {
                    self.active_terminal_tab.insert(ws_id.clone(), terminal_id);
                }
                self.terminal_focused = true;
                if let Some(term) = self.terminals.get(&terminal_id) {
                    return iced_term::TerminalView::focus(term.widget_id().clone());
                }
            }
            Message::TerminalFocusView(terminal_id) => {
                self.terminal_focused = true;
                if let Some(term) = self.terminals.get(&terminal_id) {
                    return iced_term::TerminalView::focus(term.widget_id().clone());
                }
            }

            Message::TerminalTogglePanel => {
                self.terminal_panel_visible = !self.terminal_panel_visible;
            }

            Message::TerminalEvent(event) => {
                let iced_term::Event::BackendCall(id, cmd) = event;
                // Drop keyboard input when terminal isn't focused.
                // backend::Command is not pub, so we check via Debug format.
                if !self.terminal_focused {
                    return Task::none();
                }
                if let Some(term) = self.terminals.get_mut(&id) {
                    let action = term.handle(iced_term::Command::ProxyToBackend(cmd));
                    match action {
                        iced_term::actions::Action::Shutdown => {
                            return Task::done(Message::TerminalClose(id));
                        }
                        iced_term::actions::Action::ChangeTitle(title) => {
                            for tabs in self.terminal_tabs.values_mut() {
                                if let Some(tab) = tabs.iter_mut().find(|t| t.id == id as i64) {
                                    tab.title = title.clone();
                                    break;
                                }
                            }
                            // Persist the updated title to the database
                            let db_path = self.db_path.clone();
                            let tab_id = id as i64;
                            return Task::perform(
                                async move {
                                    if let Ok(db) = Database::open(&db_path)
                                        && let Err(e) = db.update_terminal_tab_title(tab_id, &title)
                                    {
                                        eprintln!("Failed to update terminal tab title: {e}");
                                    }
                                },
                                |()| Message::ApplyDockIcon, // fire-and-forget; ApplyDockIcon is idempotent
                            );
                        }
                        iced_term::actions::Action::Ignore => {}
                    }
                }
            }

            Message::TerminalTabsLoaded(ws_id, Ok(tabs)) => {
                if tabs.is_empty() {
                    // Auto-create a terminal if none exist (always at least 1)
                    self.terminal_tabs.insert(ws_id.clone(), Vec::new());
                    return Task::done(Message::TerminalCreate(ws_id));
                }
                let ws = self.workspaces.iter().find(|w| w.id == ws_id);
                if let Some(wt_path) = ws.and_then(|w| w.worktree_path.as_deref()) {
                    let mut first_id = None;
                    for tab in &tabs {
                        let id = tab.id as u64;
                        if !self.terminals.contains_key(&id)
                            && let Ok(term) =
                                terminal::create_terminal(id, std::path::Path::new(wt_path))
                        {
                            self.terminals.insert(id, term);
                        }
                        if first_id.is_none() {
                            first_id = Some(id);
                        }
                    }
                    if let Some(id) = first_id {
                        self.active_terminal_tab.entry(ws_id.clone()).or_insert(id);
                    }
                }
                self.terminal_tabs.insert(ws_id, tabs);
                // Unfocus restored terminals so they don't capture keystrokes
                self.terminal_focused = false;
                return iced::widget::operation::focus(ui::chat_panel::chat_input_id());
            }
            Message::TerminalTabsLoaded(_ws_id, Err(e)) => {
                eprintln!("Failed to load terminal tabs: {e}");
            }

            Message::ScriptOutputCreate(ws_id, command) => {
                let ws = self.workspaces.iter().find(|w| w.id == ws_id);
                let Some(wt_path) = ws.and_then(|w| w.worktree_path.as_deref()) else {
                    return Task::none();
                };

                let id = terminal::next_terminal_id();
                match terminal::create_script_terminal(id, std::path::Path::new(wt_path), &command)
                {
                    Ok(term) => {
                        self.terminals.insert(id, term);
                        let sort_order = self
                            .terminal_tabs
                            .get(&ws_id)
                            .and_then(|tabs| tabs.iter().map(|t| t.sort_order).max())
                            .map(|max| max + 1)
                            .unwrap_or(0);
                        let tab = TerminalTab {
                            id: id as i64,
                            workspace_id: ws_id.clone(),
                            title: command,
                            is_script_output: true,
                            sort_order,
                            created_at: String::new(),
                        };
                        self.terminal_tabs
                            .entry(ws_id.clone())
                            .or_default()
                            .push(tab.clone());
                        self.active_terminal_tab.insert(ws_id.clone(), id);

                        self.terminal_focused = false;
                        let focus_chat =
                            iced::widget::operation::focus(ui::chat_panel::chat_input_id());
                        let db_path = self.db_path.clone();
                        let persist = Task::perform(
                            async move {
                                let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                                db.insert_terminal_tab(&tab).map_err(|e| e.to_string())?;
                                Ok((ws_id, tab))
                            },
                            Message::TerminalCreated,
                        );
                        return Task::batch([persist, focus_chat]);
                    }
                    Err(e) => {
                        eprintln!("Failed to create script terminal: {e}");
                    }
                }
            }

            // --- Panel resizing ---
            Message::DividerDragStart(divider) => {
                self.dragging_divider = Some(divider);
                self.drag_cursor_initialized = false;
            }
            Message::DividerDragUpdate(x, y) => {
                if self.dragging_divider.is_none() {
                    return Task::none();
                }
                if !self.drag_cursor_initialized {
                    self.last_cursor_position = iced::Point::new(x, y);
                    self.drag_cursor_initialized = true;
                    return Task::none();
                }

                let dx = x - self.last_cursor_position.x;
                let dy = y - self.last_cursor_position.y;
                self.last_cursor_position = iced::Point::new(x, y);

                if let Some(divider) = self.dragging_divider {
                    match divider {
                        crate::message::DividerDrag::LeftSidebar => {
                            self.sidebar_width = (self.sidebar_width + dx).clamp(150.0, 500.0);
                        }
                        crate::message::DividerDrag::RightSidebar => {
                            self.right_sidebar_width =
                                (self.right_sidebar_width - dx).clamp(150.0, 500.0);
                        }
                        crate::message::DividerDrag::Terminal => {
                            self.terminal_height = (self.terminal_height - dy).clamp(100.0, 800.0);
                        }
                    }
                }
            }
            Message::DividerDragEnd => {
                self.dragging_divider = None;
            }
        }
        Task::none()
    }

    fn handle_stream_event(&mut self, ws_id: &str, event: StreamEvent) -> Task<Message> {
        match event {
            StreamEvent::Stream {
                event:
                    agent::InnerStreamEvent::ContentBlockDelta {
                        delta: agent::Delta::Text { text },
                        ..
                    },
            } => {
                if let Some(state) = self.agents.get_mut(ws_id) {
                    state.streaming_content.push_str(&text);
                }
            }
            StreamEvent::Assistant { message } => {
                // Complete assistant message — persist and add to chat
                let full_text: String = message
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        agent::ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");

                // Clear streaming content
                if let Some(state) = self.agents.get_mut(ws_id) {
                    state.streaming_content.clear();
                }

                let assistant_msg = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: ws_id.to_string(),
                    role: ChatRole::Assistant,
                    content: full_text,
                    cost_usd: None,
                    duration_ms: None,
                    created_at: String::new(),
                };

                self.chat_messages
                    .entry(ws_id.to_string())
                    .or_default()
                    .push(assistant_msg.clone());
                self.rebuild_markdown_cache(ws_id);

                let db_path = self.db_path.clone();
                return Task::perform(
                    async move {
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.insert_chat_message(&assistant_msg)
                            .map_err(|e| e.to_string())?;
                        Ok(assistant_msg)
                    },
                    Message::ChatMessageSaved,
                );
            }
            StreamEvent::Result {
                total_cost_usd,
                duration_ms,
                ..
            } => {
                // Agent finished processing — update last assistant message cost
                if let Some(msgs) = self.chat_messages.get(ws_id)
                    && let Some(last_msg) =
                        msgs.iter().rev().find(|m| m.role == ChatRole::Assistant)
                    && let (Some(cost), Some(dur)) = (total_cost_usd, duration_ms)
                {
                    let msg_id = last_msg.id.clone();
                    let db_path = self.db_path.clone();
                    return Task::perform(
                        async move {
                            let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                            db.update_chat_message_cost(&msg_id, cost, dur)
                                .map_err(|e| e.to_string())?;
                            Ok(())
                        },
                        |_: Result<(), String>| Message::Noop,
                    );
                }

                // Clear streaming
                if let Some(state) = self.agents.get_mut(ws_id) {
                    state.streaming_content.clear();
                }
            }
            _ => {
                // Other events (system init, message_start, etc.) — ignored for now
            }
        }
        Task::none()
    }

    /// Build an async task that loads changed files for the currently selected workspace.
    /// Returns `None` if no workspace is selected or the workspace has no worktree.
    fn load_diff_files_task(&self) -> Option<Task<Message>> {
        let ws_id = self.selected_workspace.as_ref()?;
        let ws = self.workspaces.iter().find(|w| w.id == *ws_id)?;
        let worktree_path = ws.worktree_path.clone()?;
        let repo = self
            .repositories
            .iter()
            .find(|r| r.id == ws.repository_id)?;
        let repo_path = repo.path.clone();

        Some(Task::perform(
            async move {
                let base_branch = git::default_branch(&repo_path)
                    .await
                    .map_err(|e| e.to_string())?;
                let mb = diff::merge_base(&worktree_path, "HEAD", &base_branch)
                    .await
                    .map_err(|e| e.to_string())?;
                let files = diff::changed_files(&worktree_path, &mb)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok((files, mb))
            },
            Message::DiffFilesLoaded,
        ))
    }

    fn fuzzy_filtered_workspaces(&self) -> impl Iterator<Item = &Workspace> {
        let query = self.fuzzy_query.to_lowercase();
        self.workspaces.iter().filter(move |ws| {
            if query.is_empty() {
                return true;
            }
            ws.name.to_lowercase().contains(&query)
                || ws.branch_name.to_lowercase().contains(&query)
        })
    }

    pub fn view(&self) -> Element<'_, Message> {
        let mut layout = Row::new();

        if self.sidebar_visible {
            layout = layout.push(ui::view_sidebar(
                &self.repositories,
                &self.workspaces,
                self.selected_workspace.as_deref(),
                &self.sidebar_filter,
                &self.repo_collapsed,
                self.sidebar_width,
            ));
            layout = layout.push(ui::divider::vertical_divider(
                crate::message::DividerDrag::LeftSidebar,
            ));
        }

        // Get chat data for selected workspace
        let (msgs, md_items, streaming) = if let Some(ws_id) = &self.selected_workspace {
            let msgs = self
                .chat_messages
                .get(ws_id)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            let md = self
                .markdown_cache
                .get(ws_id)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            let streaming = self
                .agents
                .get(ws_id)
                .map(|s| s.streaming_content.as_str())
                .unwrap_or("");
            (msgs, md, streaming)
        } else {
            (&[] as &[ChatMessage], &[] as &[Vec<markdown::Item>], "")
        };

        let (term_tabs, active_term) = if let Some(ws_id) = &self.selected_workspace {
            let tabs = self
                .terminal_tabs
                .get(ws_id)
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            let active = self.active_terminal_tab.get(ws_id).copied();
            (tabs, active)
        } else {
            (&[] as &[TerminalTab], None)
        };

        layout = layout.push(ui::view_main_content(
            &self.repositories,
            &self.workspaces,
            self.selected_workspace.as_deref(),
            msgs,
            &self.chat_input,
            streaming,
            md_items,
            &self.diff_files,
            self.diff_selected_file.as_deref(),
            self.diff_content.as_ref(),
            self.diff_view_mode,
            self.diff_loading,
            self.diff_error.as_deref(),
            &self.terminals,
            term_tabs,
            active_term,
            self.terminal_panel_visible,
            self.terminal_height,
        ));

        // Right sidebar
        if self.right_sidebar_visible {
            layout = layout.push(ui::divider::vertical_divider(
                crate::message::DividerDrag::RightSidebar,
            ));
            layout = layout.push(ui::view_right_sidebar(
                self.right_sidebar_tab,
                &self.diff_files,
                self.diff_selected_file.as_deref(),
                self.diff_view_mode,
                self.diff_loading,
                self.right_sidebar_width,
            ));
        }

        // Wrap in Column with toolbar at top
        let base: Element<'_, Message> = iced::widget::Column::new()
            .push(ui::view_status_bar(
                self.sidebar_visible,
                self.terminal_panel_visible,
                self.right_sidebar_visible,
            ))
            .push(
                iced::widget::container(layout)
                    .width(iced::Fill)
                    .height(iced::Fill),
            )
            .width(iced::Fill)
            .height(iced::Fill)
            .into();

        // Icon picker layered on top of repo settings modal
        if self.show_icon_picker && self.show_repo_settings.is_some() {
            let repo_id = self.show_repo_settings.as_deref().unwrap_or("");
            let repo_settings_base = ui::view_repo_settings_modal(
                base,
                repo_id,
                &self.repo_settings_name_input,
                self.repo_settings_icon_input.as_deref(),
                self.repo_settings_error.as_ref(),
            );
            let filtered = crate::icons::search(&self.icon_picker_query);
            return ui::view_icon_picker(repo_settings_base, &self.icon_picker_query, &filtered);
        }

        if self.show_repo_settings.is_some() {
            let repo_id = self.show_repo_settings.as_deref().unwrap_or("");
            return ui::view_repo_settings_modal(
                base,
                repo_id,
                &self.repo_settings_name_input,
                self.repo_settings_icon_input.as_deref(),
                self.repo_settings_error.as_ref(),
            );
        }

        if self.show_app_settings {
            return ui::view_app_settings_modal(
                base,
                &self.app_settings_worktree_base_input,
                self.app_settings_error.as_ref(),
            );
        }

        if self.show_fuzzy_finder {
            let filtered: Vec<_> = self.fuzzy_filtered_workspaces().collect();
            return ui::view_fuzzy_finder(
                base,
                &self.fuzzy_query,
                &filtered,
                self.fuzzy_selected_index,
                &self.repositories,
            );
        }

        if let Some(file_path) = &self.diff_revert_target {
            return ui::view_revert_file_modal(base, file_path);
        }

        if let Some(repo_id) = &self.show_remove_repository {
            let repo_name = self
                .repositories
                .iter()
                .find(|r| r.id == *repo_id)
                .map(|r| r.name.as_str())
                .unwrap_or("this repository");
            let active_count = self
                .workspaces
                .iter()
                .filter(|w| w.repository_id == *repo_id && w.status == WorkspaceStatus::Active)
                .count();
            let archived_count = self
                .workspaces
                .iter()
                .filter(|w| w.repository_id == *repo_id && w.status == WorkspaceStatus::Archived)
                .count();
            return ui::view_remove_repo_modal(
                base,
                repo_name,
                active_count,
                archived_count,
                self.remove_repo_error.as_ref(),
            );
        }

        if let Some(ws_id) = &self.show_delete_workspace {
            let ws_name = self
                .workspaces
                .iter()
                .find(|w| w.id == *ws_id)
                .map(|w| w.name.as_str())
                .unwrap_or("this workspace");
            return ui::view_delete_workspace_modal(base, ws_name);
        }

        if let Some(repo_id) = &self.show_create_workspace {
            let repo_name = self
                .repositories
                .iter()
                .find(|r| r.id == *repo_id)
                .map(|r| r.name.as_str())
                .unwrap_or("Unknown");
            return ui::view_create_workspace_modal(
                base,
                repo_name,
                &self.create_workspace_name,
                self.create_workspace_error.as_ref(),
            );
        }

        if let Some(repo_id) = &self.show_relink_repo {
            let repo_name = self
                .repositories
                .iter()
                .find(|r| r.id == *repo_id)
                .map(|r| r.name.as_str())
                .unwrap_or("Unknown");
            return ui::view_relink_repo_modal(
                base,
                repo_name,
                &self.relink_repo_path_input,
                self.relink_repo_error.as_ref(),
            );
        }

        if self.show_add_repo {
            return ui::view_add_repo_modal(
                base,
                &self.add_repo_path_input,
                self.add_repo_error.as_ref(),
            );
        }

        base
    }

    pub fn subscription(&self) -> Subscription<Message> {
        let input_sub = event::listen_with(|event, status, _id| match &event {
            iced::Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) => {
                match key {
                    Key::Character(c) if c.as_ref() == "b" && modifiers.command() => {
                        Some(Message::ToggleSidebar)
                    }
                    Key::Character(c) if c.as_ref() == "k" && modifiers.command() => {
                        Some(Message::ToggleFuzzyFinder)
                    }
                    Key::Character(c) if c.as_ref() == "d" && modifiers.command() => {
                        Some(Message::ToggleRightSidebar)
                    }
                    Key::Character(c) if c.as_ref() == "`" && modifiers.command() => {
                        Some(Message::TerminalTogglePanel)
                    }
                    // Only handle Up/Down when no widget (e.g. terminal) has captured the event
                    Key::Named(keyboard::key::Named::ArrowUp)
                        if modifiers.is_empty() && status == event::Status::Ignored =>
                    {
                        Some(Message::ChatHistoryUp)
                    }
                    Key::Named(keyboard::key::Named::ArrowDown)
                        if modifiers.is_empty() && status == event::Status::Ignored =>
                    {
                        Some(Message::ChatHistoryDown)
                    }
                    Key::Named(keyboard::key::Named::Escape) => Some(Message::EscapePressed),
                    _ => None,
                }
            }
            iced::Event::Mouse(iced::mouse::Event::CursorMoved { position }) => {
                Some(Message::DividerDragUpdate(position.x, position.y))
            }
            iced::Event::Mouse(iced::mouse::Event::ButtonReleased(iced::mouse::Button::Left)) => {
                Some(Message::DividerDragEnd)
            }
            _ => None,
        });

        // Agent streaming subscriptions — one per active agent
        let agent_subs: Vec<Subscription<Message>> = self
            .agents
            .iter()
            .map(|(ws_id, state)| {
                let data = AgentSubData {
                    ws_id: ws_id.clone(),
                    event_rx: state.handle.event_rx.clone(),
                };
                Subscription::run_with(data, agent_stream)
            })
            .collect();

        // Terminal subscriptions — one per live terminal instance
        let terminal_subs: Vec<Subscription<Message>> = self
            .terminals
            .values()
            .map(|term| term.subscription().map(Message::TerminalEvent))
            .collect();

        let mut subs = vec![input_sub];
        subs.extend(agent_subs);
        subs.extend(terminal_subs);
        Subscription::batch(subs)
    }

    pub fn theme(&self) -> Theme {
        Theme::Dark
    }
}

/// Sets the macOS dock icon programmatically.
///
/// On macOS, `iced::window::Settings::icon` only affects the titlebar (which macOS doesn't
/// display). The dock icon requires setting it via NSApplication after Iced has initialized.
#[cfg(target_os = "macos")]
fn set_dock_icon() {
    use objc2::AnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    unsafe {
        let data = NSData::initWithBytes_length(
            NSData::alloc(),
            crate::ICON_PNG.as_ptr().cast(),
            crate::ICON_PNG.len(),
        );
        if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
            let app = NSApplication::sharedApplication(mtm);
            app.setApplicationIconImage(Some(&image));
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn set_dock_icon() {}
