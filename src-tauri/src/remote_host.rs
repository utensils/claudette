//! In-process host for "Share this machine".
//!
//! The WSS transport, pairing, and TLS come from `claudette-server`; request
//! handling and events come from this app. Remote clients therefore drive
//! the same command core (and the same live agent sessions) as the local
//! window, instead of a second agent runtime in a child process.
//!
//! Wire protocol: method names and snake_case params match the standalone
//! server (`src-server/src/handler.rs`), so a client behaves the same
//! against a desktop host and a headless one. Methods not handled here fall
//! through to the CLI's IPC dispatch (`ipc::dispatch_method`).

use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::{AppHandle, EventId, Listener, Manager};
use tokio::sync::broadcast;

use claudette::db::Database;
use claudette_server::RpcHost;

use crate::state::AppState;

/// Local Tauri events re-broadcast to paired clients. Each carries the
/// workspace / session / PTY ID a client needs to route it.
const FORWARDED_EVENTS: &[&str] = &[
    "agent-stream",
    "agent-permission-prompt",
    "agent-background-task",
    "agent-task-output",
    "agent-attachment-created",
    "agent-conclusion-created",
    "checkpoint-created",
    "chat-turn-started",
    "chat-turn-settings",
    "chat-system-message",
    "chat-session-created",
    "session-renamed",
    "workspace-renamed",
    "workspaces-changed",
    "workspace_env_progress",
    "workflow-activity-status",
    "pty-output",
    "pty-exit",
];

/// Capacity of the outbound event bus. Matches the standalone server.
const EVENT_CHANNEL_CAPACITY: usize = 4096;

pub struct TauriRpcHost {
    app: AppHandle,
    events: broadcast::Sender<Value>,
    listeners: Mutex<Vec<EventId>>,
}

impl TauriRpcHost {
    /// Create the host and start mirroring [`FORWARDED_EVENTS`] onto its
    /// event bus. Call [`Self::detach`] when the server stops.
    pub fn attach(app: AppHandle) -> std::sync::Arc<Self> {
        let events = broadcast::channel(EVENT_CHANNEL_CAPACITY).0;
        let host = std::sync::Arc::new(Self {
            app: app.clone(),
            events: events.clone(),
            listeners: Mutex::new(Vec::new()),
        });
        let mut ids = Vec::with_capacity(FORWARDED_EVENTS.len());
        for &name in FORWARDED_EVENTS {
            let tx = events.clone();
            ids.push(app.listen_any(name, move |event| {
                if let Some(envelope) = outbound_envelope(name, event.payload()) {
                    let _ = tx.send(envelope);
                }
            }));
        }
        if let Ok(mut listeners) = host.listeners.lock() {
            *listeners = ids;
        }
        host
    }

    /// Stop mirroring local events.
    pub fn detach(&self) {
        let ids = match self.listeners.lock() {
            Ok(mut listeners) => std::mem::take(&mut *listeners),
            Err(_) => return,
        };
        for id in ids {
            self.app.unlisten(id);
        }
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }
}

/// Build the `{"event", "payload"}` envelope for a local event, or `None`
/// when it shouldn't leave this machine.
///
/// Events that arrived *from* another machine (the desktop client tags them
/// with `remote_connection_id`) are dropped: re-broadcasting them would
/// loop when two machines are paired with each other.
fn outbound_envelope(name: &str, raw_payload: &str) -> Option<Value> {
    let mut payload: Value = serde_json::from_str(raw_payload).ok()?;
    if payload.get("remote_connection_id").is_some() {
        return None;
    }
    // The mobile client reads `session_id` on agent-stream; the desktop
    // reads `chat_session_id`. Same aliasing as the standalone server.
    if name == "agent-stream"
        && let Some(obj) = payload.as_object_mut()
        && let Some(id) = obj.get("chat_session_id").cloned()
    {
        obj.entry("session_id").or_insert(id);
    }
    Some(json!({ "event": name, "payload": payload }))
}

fn str_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("missing {key}"))
}

fn chat_session_param(params: &Value) -> Result<String, String> {
    str_param(params, "chat_session_id").or_else(|_| str_param(params, "session_id"))
}

fn u64_param(params: &Value, key: &str) -> Result<u64, String> {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| format!("missing {key}"))
}

fn u16_param_or(params: &Value, key: &str, default: u16) -> u16 {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .unwrap_or(default)
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

#[async_trait::async_trait]
impl RpcHost for TauriRpcHost {
    async fn dispatch(&self, method: &str, mut params: Value) -> Result<Value, String> {
        use crate::commands;

        let app = &self.app;
        match method {
            "load_initial_data" => to_value(commands::data::load_initial_data(self.state()).await?),
            "load_chat_history" => to_value(
                commands::chat::send::load_chat_history(chat_session_param(&params)?, self.state())
                    .await?,
            ),
            "load_diff_files" => to_value(
                commands::diff::load_diff_files(str_param(&params, "workspace_id")?, self.state())
                    .await?,
            ),
            "load_file_diff" => to_value(
                commands::diff::load_file_diff(
                    str_param(&params, "worktree_path")?,
                    str_param(&params, "merge_base")?,
                    str_param(&params, "file_path")?,
                    params
                        .get("diff_layer")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                )
                .await?,
            ),
            "load_commit_file_diff" => to_value(
                commands::diff::load_commit_file_diff(
                    str_param(&params, "worktree_path")?,
                    str_param(&params, "commit_hash")?,
                    str_param(&params, "file_path")?,
                )
                .await?,
            ),
            "read_plan_file" => {
                to_value(commands::plan::read_plan_file(str_param(&params, "path")?).await?)
            }
            "restore_workspace" => {
                let id = str_param(&params, "workspace_id")?;
                let worktree_path =
                    commands::workspace::restore_workspace(id, app.clone(), self.state()).await?;
                Ok(json!({ "worktree_path": worktree_path }))
            }
            "submit_agent_approval" => {
                commands::chat::interaction::submit_agent_approval(
                    chat_session_param(&params)?,
                    str_param(&params, "tool_use_id")?,
                    params
                        .get("approved")
                        .and_then(|v| v.as_bool())
                        .ok_or("missing approved")?,
                    params
                        .get("reason")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    self.state(),
                )
                .await?;
                Ok(json!(null))
            }
            "spawn_pty" => self.spawn_pty(&params).await,
            "write_pty" => {
                let data: Vec<u8> = params
                    .get("data")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| format!("invalid data: {e}"))?
                    .unwrap_or_default();
                crate::pty::write_pty(u64_param(&params, "pty_id")?, data, self.state()).await?;
                Ok(json!(null))
            }
            "resize_pty" => {
                crate::pty::resize_pty(
                    u64_param(&params, "pty_id")?,
                    u16_param_or(&params, "cols", 80),
                    u16_param_or(&params, "rows", 24),
                    self.state(),
                )
                .await?;
                Ok(json!(null))
            }
            "close_pty" => {
                crate::pty::close_pty(u64_param(&params, "pty_id")?, self.state()).await?;
                Ok(json!(null))
            }
            _ => {
                // The standalone server's `create_workspace` takes
                // `repository_id`; the IPC handler takes `repo_id`.
                if method == "create_workspace"
                    && params.get("repo_id").is_none()
                    && let Some(repo_id) = params.get("repository_id").cloned()
                    && let Some(obj) = params.as_object_mut()
                {
                    obj.insert("repo_id".into(), repo_id);
                }
                crate::ipc::dispatch_method(app, method, &params).await
            }
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }
}

impl TauriRpcHost {
    /// Open a shell in a workspace. Params: `workspace_id`, optional `cwd`
    /// (defaults to the worktree), `rows`, `cols`. Returns `{"pty_id"}`;
    /// output arrives as `pty-output` events.
    async fn spawn_pty(&self, params: &Value) -> Result<Value, String> {
        let workspace_id = str_param(params, "workspace_id")?;
        let (workspace, repo) = {
            let db = Database::open(&self.state().db_path).map_err(|e| e.to_string())?;
            let workspace = db
                .list_workspaces()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|w| w.id == workspace_id)
                .ok_or("Workspace not found")?;
            let repo = db
                .get_repository(&workspace.repository_id)
                .map_err(|e| e.to_string())?
                .ok_or("Repository not found")?;
            (workspace, repo)
        };
        let worktree_path = workspace
            .worktree_path
            .clone()
            .ok_or("Workspace has no worktree")?;
        let cwd = params
            .get("cwd")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| worktree_path.clone());
        let default_branch = match repo.base_branch.clone() {
            Some(branch) => branch,
            None => claudette::git::default_branch(&repo.path, repo.default_remote.as_deref())
                .await
                .unwrap_or_else(|_| "main".into()),
        };

        let pty_id = crate::pty::spawn_pty(
            cwd,
            workspace.name.clone(),
            workspace.id.clone(),
            repo.path.clone(),
            default_branch,
            workspace.branch_name.clone(),
            self.app.clone(),
            self.state(),
        )
        .await?;
        let _ = crate::pty::resize_pty(
            pty_id,
            u16_param_or(params, "cols", 80),
            u16_param_or(params, "rows", 24),
            self.state(),
        )
        .await;
        Ok(json!({ "pty_id": pty_id }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outbound_envelope_aliases_session_id_on_agent_stream() {
        let env = outbound_envelope(
            "agent-stream",
            r#"{"workspace_id":"w","chat_session_id":"c","event":{}}"#,
        )
        .unwrap();
        assert_eq!(env["event"], "agent-stream");
        assert_eq!(env["payload"]["chat_session_id"], "c");
        assert_eq!(env["payload"]["session_id"], "c");
    }

    #[test]
    fn outbound_envelope_drops_events_relayed_from_another_machine() {
        assert!(
            outbound_envelope(
                "agent-stream",
                r#"{"chat_session_id":"c","remote_connection_id":"peer"}"#
            )
            .is_none()
        );
    }

    #[test]
    fn outbound_envelope_leaves_other_events_untouched() {
        let env = outbound_envelope("pty-exit", r#"{"pty_id":3}"#).unwrap();
        assert_eq!(env, json!({"event": "pty-exit", "payload": {"pty_id": 3}}));
    }
}
