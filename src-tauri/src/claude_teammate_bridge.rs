//! Claude Code agent-team teammate bridge.
//!
//! Claude Code's TeamCreate tool only writes team metadata. Its Agent tool
//! launches teammates by running the command named by
//! `CLAUDE_CODE_TEAMMATE_COMMAND` with `--agent-id`, `--agent-name`, and
//! `--team-name` flags. Claudette sets that env var to this executable, so
//! those launches come back through this lightweight child mode instead of
//! starting another Claude Code terminal session.

use std::path::{Path, PathBuf};
use std::time::Duration;

use claudette::rpc::{RpcError, RpcRequest, RpcResponse};
use interprocess::local_socket::Name;
use interprocess::local_socket::tokio::{Stream, prelude::*};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const STARTUP_MESSAGE_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) fn is_teammate_launch(args: &[String]) -> bool {
    has_flag(args, "--agent-id") && has_flag(args, "--agent-name") && has_flag(args, "--team-name")
}

pub(crate) fn is_send_chat_launch(args: &[String]) -> bool {
    has_flag(args, "--claudette-send-chat")
}

pub(crate) async fn run_send_chat_from_args(args: Vec<String>) -> Result<(), String> {
    let session_id = flag_value(&args, "--session-id")?.to_string();
    let prompt_file = PathBuf::from(flag_value(&args, "--prompt-file")?);
    let content = tokio::fs::read_to_string(&prompt_file)
        .await
        .map_err(|e| format!("read prompt file {}: {e}", prompt_file.display()))?;
    // The prompt is now in memory; remove the temp file before the IPC call so
    // failures in `send_chat_message` do not leave sensitive prompt text behind.
    let _ = tokio::fs::remove_file(&prompt_file).await;
    let model = flag_value(&args, "--model").ok().map(str::to_string);
    let plan_mode = has_flag(&args, "--plan-mode");
    let info = read_app_info()?;
    let mut params = json!({
        "session_id": session_id,
        "content": content,
        "permission_level": "full",
    });
    if let Some(model) = model {
        params["model"] = Value::String(model);
    }
    if plan_mode {
        params["plan_mode"] = Value::Bool(true);
    }
    rpc_call(&info, "send_chat_message", params).await?;
    Ok(())
}

pub(crate) async fn run_from_args(args: Vec<String>) -> Result<(), String> {
    let launch = TeammateLaunch::parse(&args)?;
    println!(
        "Claudette teammate bridge: redirecting Claude Code teammate '{}' from team '{}' into Claudette",
        launch.agent_name, launch.team_name
    );

    let info = read_app_info()?;
    let workspaces = rpc_call(&info, "list_workspaces", json!({})).await?;
    let workspace = select_workspace(&workspaces, &launch.cwd)?;

    let session = rpc_call(
        &info,
        "create_chat_session",
        json!({ "workspace_id": workspace.id }),
    )
    .await?;
    let session_id = session
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "create_chat_session response missing id".to_string())?
        .to_string();
    let _ = rpc_call(
        &info,
        "rename_chat_session",
        json!({
            "chat_session_id": session_id,
            "name": format!("{} / {}", launch.team_name, launch.agent_name),
        }),
    )
    .await;

    println!(
        "Claudette teammate bridge: session '{}' opened in workspace '{}'; polling Claude Code mailbox for initial instructions",
        session_id, workspace.name
    );

    let inbox = inbox_path(&launch.agent_name, &launch.team_name);
    let mut saw_any_message = false;
    let started = tokio::time::Instant::now();

    loop {
        let mut messages = read_mailbox(&inbox).await?;
        let mut changed = false;
        for message in messages.iter_mut() {
            if message.read || message.from != "team-lead" {
                continue;
            }
            saw_any_message = true;
            let content = launch.decorate_prompt(&message.text);
            println!(
                "Claudette teammate bridge: forwarding mailbox message from team lead to Claudette session {}",
                session_id
            );
            let mut params = json!({
                "session_id": session_id,
                "content": content,
            });
            if let Some(model) = &launch.model {
                params["model"] = Value::String(model.clone());
            }
            if launch.plan_mode_required {
                params["plan_mode"] = Value::Bool(true);
            }
            if let Some(permission) = &launch.permission_mode {
                params["permission_level"] = Value::String(permission.clone());
            }
            rpc_call(&info, "send_chat_message", params).await?;
            message.read = true;
            changed = true;
        }
        if changed {
            write_mailbox(&inbox, &messages).await?;
            println!(
                "Claudette teammate bridge: initial instructions forwarded; exiting bridge child"
            );
            return Ok(());
        }

        if !saw_any_message && started.elapsed() > STARTUP_MESSAGE_TIMEOUT {
            println!(
                "Claudette teammate bridge: no initial mailbox message arrived within {}s; still polling",
                STARTUP_MESSAGE_TIMEOUT.as_secs()
            );
            saw_any_message = true;
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

#[derive(Debug)]
struct TeammateLaunch {
    agent_id: String,
    agent_name: String,
    team_name: String,
    agent_color: Option<String>,
    parent_session_id: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    plan_mode_required: bool,
    cwd: PathBuf,
}

impl TeammateLaunch {
    fn parse(args: &[String]) -> Result<Self, String> {
        let cwd = std::env::current_dir().map_err(|e| format!("current_dir: {e}"))?;
        Ok(Self {
            agent_id: flag_value(args, "--agent-id")?.to_string(),
            agent_name: flag_value(args, "--agent-name")?.to_string(),
            team_name: flag_value(args, "--team-name")?.to_string(),
            agent_color: flag_value(args, "--agent-color").ok().map(str::to_string),
            parent_session_id: flag_value(args, "--parent-session-id")
                .ok()
                .map(str::to_string),
            model: flag_value(args, "--model").ok().map(str::to_string),
            permission_mode: flag_value(args, "--permission-mode")
                .ok()
                .map(str::to_string),
            plan_mode_required: has_flag(args, "--plan-mode-required"),
            cwd,
        })
    }

    fn decorate_prompt(&self, prompt: &str) -> String {
        let mut header = format!(
            "You are Claude Code teammate '{}' (agent id '{}') in team '{}'. ",
            self.agent_name, self.agent_id, self.team_name
        );
        if let Some(parent) = &self.parent_session_id {
            header.push_str(&format!("Parent Claude session: {parent}. "));
        }
        if let Some(color) = &self.agent_color {
            header.push_str(&format!("Assigned teammate color: {color}. "));
        }
        if self.plan_mode_required {
            header.push_str("Start in plan mode and wait for approval before making edits. ");
        }
        header.push_str(
            "This teammate was redirected into a Claudette workspace; report progress in this chat.\n\n",
        );
        header.push_str(prompt);
        header
    }
}

fn flag_value<'a>(args: &'a [String], flag: &str) -> Result<&'a str, String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == flag).then_some(pair[1].as_str()))
        .ok_or_else(|| format!("missing {flag}"))
}

#[derive(Debug, Clone, Deserialize)]
struct WorkspaceSummary {
    id: String,
    name: String,
    worktree_path: Option<String>,
}

fn select_workspace(workspaces: &Value, cwd: &Path) -> Result<WorkspaceSummary, String> {
    let workspaces: Vec<WorkspaceSummary> = serde_json::from_value(workspaces.clone())
        .map_err(|e| format!("list_workspaces response: {e}"))?;
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());

    workspaces
        .into_iter()
        .filter(|workspace| {
            let Some(path) = &workspace.worktree_path else {
                return false;
            };
            let worktree_path = PathBuf::from(path)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(path));
            cwd.starts_with(worktree_path)
        })
        .max_by_key(|workspace| workspace.worktree_path.as_ref().map_or(0, |p| p.len()))
        .ok_or_else(|| {
            format!(
                "no active Claudette workspace matches teammate working directory {}",
                cwd.display()
            )
        })
}

fn inbox_path(agent_name: &str, team_name: &str) -> PathBuf {
    claude_config_home()
        .join("teams")
        .join(sanitize_path_component(team_name))
        .join("inboxes")
        .join(format!("{}.json", sanitize_path_component(agent_name)))
}

fn claude_config_home() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
        .unwrap_or_else(|| PathBuf::from(".claude"))
}

fn sanitize_path_component(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TeammateMessage {
    from: String,
    text: String,
    timestamp: String,
    #[serde(default)]
    read: bool,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

async fn read_mailbox(path: &Path) -> Result<Vec<TeammateMessage>, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("parse mailbox {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read mailbox {}: {e}", path.display())),
    }
}

async fn write_mailbox(path: &Path, messages: &[TeammateMessage]) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(messages).map_err(|e| format!("serialize mailbox: {e}"))?;
    tokio::fs::write(path, bytes)
        .await
        .map_err(|e| format!("write mailbox {}: {e}", path.display()))
}

fn read_app_info() -> Result<crate::app_info::AppInfo, String> {
    let path = crate::app_info::app_info_path();
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", path.display()))
}

#[derive(Serialize)]
struct TokenedRequest<'a> {
    token: &'a str,
    #[serde(flatten)]
    request: RpcRequest,
}

async fn rpc_call(
    info: &crate::app_info::AppInfo,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let name = name_for(&info.socket)?;
    let conn = Stream::connect(name)
        .await
        .map_err(|e| format!("connect IPC socket: {e}"))?;
    let mut reader = BufReader::new(&conn);
    let mut writer = &conn;

    let request = TokenedRequest {
        token: &info.token,
        request: RpcRequest {
            id: json!(format!("teammate-{}", uuid::Uuid::new_v4())),
            method: method.to_string(),
            params,
        },
    };
    let mut bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|e| format!("write IPC request: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("flush IPC request: {e}"))?;

    let mut line = String::new();
    let n = (&mut reader)
        .take(MAX_RESPONSE_BYTES + 1)
        .read_line(&mut line)
        .await
        .map_err(|e| format!("read IPC response: {e}"))?;
    if n as u64 > MAX_RESPONSE_BYTES {
        return Err(format!(
            "IPC response exceeds {MAX_RESPONSE_BYTES}-byte limit"
        ));
    }

    let response: RpcResponse =
        serde_json::from_str(line.trim()).map_err(|e| format!("malformed IPC response: {e}"))?;
    match (response.result, response.error) {
        (_, Some(RpcError { message, .. })) => Err(message),
        (Some(value), None) => Ok(value),
        (None, None) => Ok(Value::Null),
    }
}

fn name_for(addr: &str) -> Result<Name<'static>, String> {
    let owned = addr.to_string();
    #[cfg(unix)]
    {
        owned
            .to_fs_name::<GenericFilePath>()
            .map_err(|e| format!("fs name {addr}: {e}"))
    }
    #[cfg(windows)]
    {
        owned
            .to_ns_name::<GenericNamespaced>()
            .map_err(|e| format!("ns name {addr}: {e}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = owned;
        Err("unsupported platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_send_chat_launch_args() {
        let args = vec![
            "claudette-app".into(),
            "--claudette-send-chat".into(),
            "--session-id".into(),
            "s1".into(),
            "--prompt-file".into(),
            "/tmp/prompt".into(),
        ];
        assert!(is_send_chat_launch(&args));
        assert!(!is_teammate_launch(&args));
    }

    #[test]
    fn detects_teammate_launch_args() {
        let args = vec![
            "claudette-app".into(),
            "--agent-id".into(),
            "a".into(),
            "--agent-name".into(),
            "worker".into(),
            "--team-name".into(),
            "team".into(),
        ];
        assert!(is_teammate_launch(&args));
    }

    #[test]
    fn inbox_path_matches_claude_code_layout() {
        let path = inbox_path("worker.one", "team one");
        assert!(path.ends_with("teams/team-one/inboxes/worker-one.json"));
    }
}
