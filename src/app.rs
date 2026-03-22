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
use crate::model::{AgentStatus, ChatMessage, ChatRole, Repository, Workspace, WorkspaceStatus};
use crate::ui;

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

    // Delete workspace confirmation
    show_delete_workspace: Option<String>, // Some(ws_id)

    // Fuzzy finder
    show_fuzzy_finder: bool,
    fuzzy_query: String,
    fuzzy_selected_index: usize,

    // Agent state per workspace
    agents: HashMap<String, AgentState>,

    // Chat state
    chat_messages: HashMap<String, Vec<ChatMessage>>,
    chat_input: String,

    // Markdown rendering cache: workspace_id -> vec of parsed items per message
    markdown_cache: HashMap<String, Vec<Vec<markdown::Item>>>,
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
            show_delete_workspace: None,
            show_fuzzy_finder: false,
            fuzzy_query: String::new(),
            fuzzy_selected_index: 0,
            agents: HashMap::new(),
            chat_messages: HashMap::new(),
            chat_input: String::new(),
            markdown_cache: HashMap::new(),
        };

        let load_task = Task::perform(
            async move {
                let db = Database::open(&path).map_err(|e| e.to_string())?;
                let repos = db.list_repositories().map_err(|e| e.to_string())?;
                let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
                Ok((repos, workspaces))
            },
            Message::DataLoaded,
        );

        let startup = Task::batch([load_task, Task::done(Message::ApplyDockIcon)]);

        (app, startup)
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
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

                // Load chat history if not already loaded
                if !self.chat_messages.contains_key(&id) {
                    let db_path = self.db_path.clone();
                    let ws_id = id.clone();
                    return Task::perform(
                        async move {
                            let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                            db.list_chat_messages(&ws_id).map_err(|e| e.to_string())
                        },
                        move |result| Message::ChatHistoryLoaded(id, result),
                    );
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
            Message::DataLoaded(Ok((mut repos, workspaces))) => {
                for repo in &mut repos {
                    repo.path_valid = std::path::Path::new(&repo.path).join(".git").exists();
                }
                self.repositories = repos;
                self.workspaces = workspaces;
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

                        let repo = Repository {
                            id: uuid::Uuid::new_v4().to_string(),
                            path,
                            name,
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

            // --- Remove Repository ---
            Message::RemoveRepository(repo_id) => {
                let db_path = self.db_path.clone();
                return Task::perform(
                    async move {
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.delete_repository(&repo_id).map_err(|e| e.to_string())?;
                        Ok(repo_id)
                    },
                    Message::RepositoryRemoved,
                );
            }
            Message::RepositoryRemoved(Ok(repo_id)) => {
                self.repositories.retain(|r| r.id != repo_id);
                self.workspaces.retain(|w| w.repository_id != repo_id);
                if let Some(sel) = &self.selected_workspace
                    && !self.workspaces.iter().any(|w| w.id == *sel)
                {
                    self.selected_workspace = None;
                }
            }
            Message::RepositoryRemoved(Err(e)) => {
                eprintln!("Failed to remove repository: {e}");
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

                let worktree_base = claudette_home()
                    .join("workspaces")
                    .join(&repo.name)
                    .join(&ws_name);
                let worktree_path_str = worktree_base.to_string_lossy().to_string();

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
                self.selected_workspace = Some(ws_id);
                self.show_create_workspace = None;
            }
            Message::WorkspaceCreated(Err(msg)) => {
                self.create_workspace_error = Some(msg);
            }

            // --- Archive ---
            Message::ArchiveWorkspace(ws_id) => {
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

                let worktree_base = claudette_home()
                    .join("workspaces")
                    .join(&repo.name)
                    .join(&ws.name);
                let worktree_path_str = worktree_base.to_string_lossy().to_string();

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

            // --- App lifecycle ---
            Message::ApplyDockIcon => {
                set_dock_icon();
            }

            // --- Escape ---
            Message::EscapePressed => {
                if self.show_fuzzy_finder {
                    self.show_fuzzy_finder = false;
                } else if self.show_delete_workspace.is_some() {
                    self.show_delete_workspace = None;
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
                self.chat_input = text;
            }
            Message::ChatSend => {
                let Some(ws_id) = self.selected_workspace.clone() else {
                    return Task::none();
                };
                let content = self.chat_input.trim().to_string();
                if content.is_empty() {
                    return Task::none();
                }
                if !self.agents.contains_key(&ws_id) {
                    return Task::none();
                }
                self.chat_input.clear();

                // Create user message
                let user_msg = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: ws_id.clone(),
                    role: ChatRole::User,
                    content: content.clone(),
                    cost_usd: None,
                    duration_ms: None,
                    created_at: String::new(),
                };

                self.chat_messages
                    .entry(ws_id.clone())
                    .or_default()
                    .push(user_msg.clone());
                self.rebuild_markdown_cache(&ws_id);

                // Send to agent via stdin
                let mut tasks = vec![];
                if let Some(state) = self.agents.get(&ws_id) {
                    let stdin_tx = state.handle.stdin_tx.clone();
                    tasks.push(Task::perform(
                        async move {
                            agent::send_user_message(&stdin_tx, &content).await.ok();
                        },
                        |()| Message::ChatInputChanged(String::new()), // no-op callback
                    ));
                }

                // Persist user message
                let db_path = self.db_path.clone();
                tasks.push(Task::perform(
                    async move {
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.insert_chat_message(&user_msg)
                            .map_err(|e| e.to_string())?;
                        Ok(user_msg)
                    },
                    Message::ChatMessageSaved,
                ));

                return Task::batch(tasks);
            }
            Message::ChatMessageSaved(Ok(_msg)) => {
                // Message persisted successfully
            }
            Message::ChatMessageSaved(Err(e)) => {
                eprintln!("Failed to save chat message: {e}");
            }
            Message::ChatHistoryLoaded(ws_id, Ok(messages)) => {
                self.chat_messages.insert(ws_id.clone(), messages);
                self.rebuild_markdown_cache(&ws_id);
            }
            Message::ChatHistoryLoaded(_ws_id, Err(e)) => {
                eprintln!("Failed to load chat history: {e}");
            }

            // --- Markdown link ---
            Message::ChatLinkClicked(url) => {
                if let Err(e) = open::that(&url) {
                    eprintln!("Failed to open URL {url}: {e}");
                }
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
                        |_: Result<(), String>| Message::ChatInputChanged(String::new()),
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

    fn rebuild_markdown_cache(&mut self, ws_id: &str) {
        if let Some(messages) = self.chat_messages.get(ws_id) {
            let cache = self
                .markdown_cache
                .entry(ws_id.to_string())
                .or_insert_with(|| Vec::with_capacity(messages.len()));

            // Truncate if messages were removed
            if cache.len() > messages.len() {
                cache.truncate(messages.len());
            }

            // Only parse new messages beyond what's already cached
            for msg in messages.iter().skip(cache.len()) {
                if msg.role == ChatRole::Assistant {
                    cache.push(markdown::parse(&msg.content).collect());
                } else {
                    cache.push(Vec::new());
                }
            }
        }
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

        layout = layout.push(ui::view_main_content(
            &self.repositories,
            &self.workspaces,
            self.selected_workspace.as_deref(),
            msgs,
            &self.chat_input,
            streaming,
            md_items,
        ));

        let base: Element<'_, Message> = layout.into();

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
        let keyboard_sub = event::listen_with(|event, _status, _id| {
            if let iced::Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) =
                &event
            {
                match key {
                    Key::Character(c) if c.as_ref() == "b" && modifiers.command() => {
                        return Some(Message::ToggleSidebar);
                    }
                    Key::Character(c) if c.as_ref() == "k" && modifiers.command() => {
                        return Some(Message::ToggleFuzzyFinder);
                    }
                    Key::Named(keyboard::key::Named::Escape) => {
                        return Some(Message::EscapePressed);
                    }
                    _ => {}
                }
            }
            None
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

        let mut subs = vec![keyboard_sub];
        subs.extend(agent_subs);
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
