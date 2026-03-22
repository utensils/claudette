use std::collections::HashMap;
use std::path::PathBuf;

use iced::event;
use iced::keyboard::{self, Key};
use iced::widget::Row;
use iced::{Element, Subscription, Task, Theme};

use crate::db::Database;
use crate::message::{Message, SidebarFilter};
use crate::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};
use crate::ui;

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

    // Fuzzy finder
    show_fuzzy_finder: bool,
    fuzzy_query: String,
    fuzzy_selected_index: usize,
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
            show_fuzzy_finder: false,
            fuzzy_query: String::new(),
            fuzzy_selected_index: 0,
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

        (app, load_task)
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            // --- Sidebar ---
            Message::ToggleSidebar => {
                self.sidebar_visible = !self.sidebar_visible;
            }
            Message::SelectWorkspace(id) => {
                self.selected_workspace = Some(id);
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
            Message::DataLoaded(Err(_)) => {
                // DB load failed — start with empty state
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
            Message::RepositoryRemoved(Err(_)) => {}

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
                self.show_create_workspace = Some(repo_id);
                self.create_workspace_name.clear();
                self.create_workspace_error = None;
            }
            Message::HideCreateWorkspace => {
                self.show_create_workspace = None;
            }
            Message::CreateWorkspaceNameChanged(name) => {
                self.create_workspace_name = name;
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
            Message::WorkspaceArchived(Err(_)) => {}

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
                        // For restore, the branch already exists so we use worktree add without -b
                        let output = tokio::process::Command::new("git")
                            .args([
                                "-C",
                                &repo.path,
                                "worktree",
                                "add",
                                &worktree_path_str,
                                &ws.branch_name,
                            ])
                            .output()
                            .await
                            .map_err(|e| e.to_string())?;

                        if !output.status.success() {
                            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                            return Err(stderr);
                        }

                        let abs_path = std::path::Path::new(&worktree_path_str)
                            .canonicalize()
                            .map_err(|e| e.to_string())?;
                        let wt_path = abs_path.to_string_lossy().to_string();

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
            Message::WorkspaceRestored(Err(_)) => {}

            // --- Delete ---
            Message::DeleteWorkspace(ws_id) => {
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
                        // Remove worktree if active
                        if let Some(wt_path) = &ws.worktree_path {
                            crate::git::remove_worktree(&repo.path, wt_path).await.ok(); // best effort
                        }
                        // Delete branch (best effort)
                        crate::git::branch_delete(&repo.path, &ws.branch_name)
                            .await
                            .ok();
                        // Delete from DB
                        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                        db.delete_workspace(&ws.id).map_err(|e| e.to_string())?;
                        Ok(ws.id)
                    },
                    Message::WorkspaceDeleted,
                );
            }
            Message::WorkspaceDeleted(Ok(ws_id)) => {
                self.workspaces.retain(|w| w.id != ws_id);
                if self.selected_workspace.as_deref() == Some(&ws_id) {
                    self.selected_workspace = None;
                }
            }
            Message::WorkspaceDeleted(Err(_)) => {}

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

            // --- Escape ---
            Message::EscapePressed => {
                if self.show_fuzzy_finder {
                    self.show_fuzzy_finder = false;
                } else if self.show_relink_repo.is_some() {
                    self.show_relink_repo = None;
                } else if self.show_create_workspace.is_some() {
                    self.show_create_workspace = None;
                } else if self.show_add_repo {
                    self.show_add_repo = false;
                }
            }
        }
        Task::none()
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

        layout = layout.push(ui::view_main_content(
            &self.repositories,
            &self.workspaces,
            self.selected_workspace.as_deref(),
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
        event::listen_with(|event, _status, _id| {
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
        })
    }

    pub fn theme(&self) -> Theme {
        Theme::Dark
    }
}
