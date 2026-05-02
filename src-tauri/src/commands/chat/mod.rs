pub mod attachments;
pub mod checkpoint;
pub mod interaction;
pub mod lifecycle;
mod naming;
pub mod send;
pub mod session;

// Re-export the consensus resolver so the host-side resolver task in
// `commands::remote` can call into it through the canonical
// `crate::commands::chat` path.
pub use interaction::record_plan_vote;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use claudette::db::Database;
use claudette::env::WorkspaceEnv;
use claudette::git;

use crate::agent_mcp_sink::ChatBridgeSink;
use claudette::agent::AgentEvent;
use claudette::agent_mcp::bridge::{BridgeHandle, McpBridgeSession};

/// Frontend-facing input for a file attachment (base64-encoded).
#[derive(Clone, Deserialize)]
pub struct AttachmentInput {
    pub filename: String,
    pub media_type: String,
    pub data_base64: String,
    pub text_content: Option<String>,
}

/// Frontend-facing response for a stored attachment (base64-encoded data).
#[derive(Clone, Serialize)]
pub struct AttachmentResponse {
    pub id: String,
    pub message_id: String,
    pub filename: String,
    pub media_type: String,
    pub data_base64: String,
    pub text_content: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub size_bytes: i64,
    /// `"user"` for composer-supplied attachments, `"agent"` for ones the
    /// agent delivered via `mcp__claudette__send_to_user`. The frontend
    /// uses this to re-route agent attachments under the assistant message
    /// instead of the user message they were FK-anchored to. Without this
    /// on reload, persisted agent attachments display as "from you".
    pub origin: claudette::model::AttachmentOrigin,
    pub tool_use_id: Option<String>,
}

/// Paginated response returned by [`super::send::load_chat_history_page`].
/// Bundles the message page with its attachments so the frontend needs only
/// one IPC round-trip per page instead of two.
#[derive(Serialize)]
pub struct ChatHistoryPage {
    pub messages: Vec<claudette::model::ChatMessage>,
    pub attachments: Vec<AttachmentResponse>,
    pub has_more: bool,
    pub total_count: i64,
}

#[derive(Clone, Serialize)]
pub(crate) struct AgentStreamPayload {
    pub workspace_id: String,
    pub chat_session_id: String,
    pub event: AgentEvent,
}

/// How long to wait between emitting `agent-permission-prompt` and firing the
/// attention system notification. This is the window in which the webview
/// picks up the event, runs the Zustand setter, and paints the question/plan
/// card. 300ms is a compromise: long enough to cover typical React render
/// plus a macOS window-show animation (when the user had the window hidden),
/// short enough that the notification still feels tied to the trigger.
pub(crate) const ATTENTION_NOTIFY_DELAY_MS: u64 = 300;

/// Build a fresh bridge for a workspace and return an `mcp_config` JSON with
/// the synthetic `claudette` MCP server entry merged in. The Claude CLI will
/// spawn `claudette-tauri --agent-mcp` as a stdio child of itself and pass it
/// the per-session socket address + token via env vars; the grandchild then
/// connects back to the parent over the local socket.
pub(crate) async fn start_bridge_and_inject_mcp(
    app: &AppHandle,
    db_path: &std::path::Path,
    workspace_id: &str,
    chat_session_id: &str,
    base_mcp_config: Option<String>,
) -> Result<(Arc<McpBridgeSession>, Option<String>), String> {
    let sink = Arc::new(ChatBridgeSink {
        app: app.clone(),
        db_path: db_path.to_path_buf(),
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
    });
    let bridge = Arc::new(McpBridgeSession::start(sink).await?);
    let merged = inject_claudette_mcp_entry(base_mcp_config, bridge.handle())?;
    Ok((bridge, merged))
}

fn inject_claudette_mcp_entry(
    base: Option<String>,
    handle: &BridgeHandle,
) -> Result<Option<String>, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?
        .to_string_lossy()
        .to_string();

    let entry = serde_json::json!({
        "type": "stdio",
        "command": exe,
        "args": ["--agent-mcp"],
        "env": {
            claudette::agent_mcp::server::ENV_SOCKET_ADDR: handle.socket_addr,
            claudette::agent_mcp::server::ENV_TOKEN: handle.token,
        }
    });

    let mut wrapper: serde_json::Value = match base.as_deref() {
        Some(s) => serde_json::from_str(s).map_err(|e| format!("parse mcp_config: {e}"))?,
        None => serde_json::json!({"mcpServers": {}}),
    };
    let servers = wrapper
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "mcp_config missing `mcpServers` object".to_string())?;
    servers.insert(claudette::agent_mcp::server::SERVER_NAME.to_string(), entry);
    Ok(Some(wrapper.to_string()))
}

pub(crate) async fn fire_completion_notification(
    db_path: &std::path::Path,
    cesp_playback: &std::sync::Mutex<claudette::cesp::SoundPlaybackState>,
    event: crate::tray::NotificationEvent,
    ws_id: &str,
) {
    let Ok(db) = Database::open(db_path) else {
        return;
    };
    let resolved = crate::tray::resolve_notification(&db, cesp_playback, event);
    if resolved.sound != "None" {
        crate::commands::settings::play_notification_sound(resolved.sound, Some(resolved.volume));
    }
    if let Ok(Some(cmd)) = db.get_app_setting("notification_command")
        && !cmd.is_empty()
        && let Some(fresh_ws) = db
            .list_workspaces()
            .ok()
            .and_then(|wss| wss.into_iter().find(|w| w.id == ws_id))
    {
        let repo = db.get_repository(&fresh_ws.repository_id).ok().flatten();
        let repo_path = repo.as_ref().map(|r| r.path.as_str()).unwrap_or_default();
        let default_branch = match repo.as_ref().and_then(|r| r.base_branch.as_deref()) {
            Some(b) => b.to_string(),
            None => git::default_branch(
                repo_path,
                repo.as_ref().and_then(|r| r.default_remote.as_deref()),
            )
            .await
            .unwrap_or_else(|_| "main".into()),
        };
        let fresh_env = WorkspaceEnv::from_workspace(&fresh_ws, repo_path, default_branch);
        if let Some(mut command) =
            crate::commands::settings::build_notification_command(&cmd, &fresh_env)
            && let Ok(child) = command.spawn()
        {
            crate::commands::settings::spawn_and_reap(child);
        }
    }
}

pub(crate) fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}

#[cfg(test)]
mod mcp_inject_tests {
    use super::inject_claudette_mcp_entry;
    use claudette::agent_mcp::bridge::BridgeHandle;

    fn handle() -> BridgeHandle {
        BridgeHandle {
            socket_addr: "/tmp/cmcp/abc.sock".into(),
            token: "secret".into(),
        }
    }

    #[test]
    fn inject_into_empty_config_creates_wrapper() {
        let merged = inject_claudette_mcp_entry(None, &handle())
            .unwrap()
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert!(v["mcpServers"]["claudette"]["command"].is_string());
        let args = v["mcpServers"]["claudette"]["args"].as_array().unwrap();
        assert_eq!(args[0], "--agent-mcp");
        let env = &v["mcpServers"]["claudette"]["env"];
        assert_eq!(env["CLAUDETTE_MCP_SOCKET"], "/tmp/cmcp/abc.sock");
        assert_eq!(env["CLAUDETTE_MCP_TOKEN"], "secret");
    }

    #[test]
    fn inject_preserves_existing_servers() {
        let base = serde_json::json!({
            "mcpServers": {
                "playwright": {"type": "stdio", "command": "npx", "args": ["pw"]}
            }
        })
        .to_string();
        let merged = inject_claudette_mcp_entry(Some(base), &handle())
            .unwrap()
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert!(v["mcpServers"]["playwright"]["command"].is_string());
        assert_eq!(
            v["mcpServers"]["claudette"]["env"]["CLAUDETTE_MCP_TOKEN"],
            "secret"
        );
    }

    #[test]
    fn inject_overwrites_collision_with_claudette_name() {
        // If a user happened to define an MCP server called `claudette`, our
        // injected entry takes precedence — it's not user-configurable and
        // we control the wire-up.
        let base = serde_json::json!({
            "mcpServers": {
                "claudette": {"type": "stdio", "command": "rogue"}
            }
        })
        .to_string();
        let merged = inject_claudette_mcp_entry(Some(base), &handle())
            .unwrap()
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["mcpServers"]["claudette"]["args"][0], "--agent-mcp");
        assert_ne!(v["mcpServers"]["claudette"]["command"], "rogue");
    }

    #[test]
    fn inject_rejects_malformed_base_json() {
        let res = inject_claudette_mcp_entry(Some("not-json".into()), &handle());
        assert!(res.is_err());
    }
}
