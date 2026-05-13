use std::collections::HashMap;
use std::io::Write as _;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use claudette::agent::{AgentEvent, Delta, InnerStreamEvent, StartContentBlock, StreamEvent};
use claudette::db::Database;

use crate::state::AppState;

const TEAM_AGENT_SESSION_TABS_SETTING: &str = "team_agent_session_tabs_enabled";

pub(in crate::commands::chat) fn team_agent_session_tabs_enabled(db: &Database) -> bool {
    db.get_app_setting(TEAM_AGENT_SESSION_TABS_SETTING)
        .ok()
        .flatten()
        .as_deref()
        != Some("false")
}

#[derive(Default)]
pub(super) struct TeamAgentInputTracker {
    inputs: HashMap<usize, (String, String)>,
}

impl TeamAgentInputTracker {
    pub(super) fn observe_event(
        &mut self,
        event: &AgentEvent,
        team_agent_tabs_enabled: bool,
        app: &AppHandle,
        workspace_id: &str,
    ) {
        if !team_agent_tabs_enabled {
            return;
        }

        if let AgentEvent::Stream(StreamEvent::Stream {
            event:
                InnerStreamEvent::ContentBlockStart {
                    index,
                    content_block: Some(StartContentBlock::ToolUse { id, name }),
                },
        }) = event
            && name == "Agent"
        {
            self.inputs.insert(*index, (id.clone(), String::new()));
            return;
        }

        if let AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockDelta { index, delta },
        }) = event
        {
            if let Some((_tool_use_id, input)) = self.inputs.get_mut(index) {
                match delta {
                    Delta::ToolUse {
                        partial_json: Some(part),
                    }
                    | Delta::InputJson {
                        partial_json: Some(part),
                    } => input.push_str(part),
                    _ => {}
                }
            }
            return;
        }

        if let AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockStop { index },
        }) = event
            && let Some((_tool_use_id, input_json)) = self.inputs.remove(index)
        {
            let app_for_team_agent = app.clone();
            let workspace_id_for_team_agent = workspace_id.to_string();
            tokio::spawn(async move {
                if let Err(err) = open_claudette_session_for_team_agent(
                    app_for_team_agent,
                    workspace_id_for_team_agent,
                    input_json,
                )
                .await
                {
                    tracing::warn!(target: "claudette::chat", error = %err, "failed to open Claudette session for Claude Code team Agent tool");
                }
            });
        }
    }
}

#[derive(Debug, Deserialize)]
struct ClaudeTeamAgentInput {
    team_name: Option<String>,
    name: Option<String>,
    prompt: Option<String>,
    description: Option<String>,
    model: Option<String>,
    plan_mode_required: Option<bool>,
}

#[derive(Debug, PartialEq, Eq)]
struct ClaudeTeamAgentDispatch {
    session_name: String,
    content: String,
    model: Option<String>,
    plan_mode: bool,
}

fn build_claudette_dispatch_for_team_agent(
    input_json: &str,
) -> Result<Option<ClaudeTeamAgentDispatch>, String> {
    let input: ClaudeTeamAgentInput = serde_json::from_str(input_json)
        .map_err(|e| format!("parse Agent tool input for Claudette session bridge: {e}"))?;
    let Some(team_name) = input
        .team_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let Some(agent_name) = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let Some(prompt) = input
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };

    let mut content = format!(
        "You are Claude Code teammate `{agent_name}` in team `{team_name}`. \
This teammate was redirected into a Claudette session tab. Report progress and final results here.\n\n{prompt}"
    );
    if let Some(description) = input
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        content = format!("Task: {description}\n\n{content}");
    }

    Ok(Some(ClaudeTeamAgentDispatch {
        session_name: format!("{team_name} / {agent_name}"),
        content,
        model: input.model,
        plan_mode: input.plan_mode_required.unwrap_or(false),
    }))
}

fn write_secure_prompt_file(content: &str) -> Result<std::path::PathBuf, String> {
    let prompt_file =
        std::env::temp_dir().join(format!("claudette-team-agent-{}.txt", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let write_result = options
        .open(&prompt_file)
        .and_then(|mut file| file.write_all(content.as_bytes()))
        .map_err(|e| format!("write prompt file {}: {e}", prompt_file.display()));
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&prompt_file);
        return Err(e);
    }
    Ok(prompt_file)
}

fn spawn_claudette_send_chat_child(
    session_id: &str,
    content: &str,
    model: Option<&str>,
    plan_mode: bool,
) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let prompt_file = write_secure_prompt_file(content)?;

    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--claudette-send-chat")
        .arg("--session-id")
        .arg(session_id)
        .arg("--prompt-file")
        .arg(&prompt_file);
    if let Some(model) = model {
        cmd.arg("--model").arg(model);
    }
    if plan_mode {
        cmd.arg("--plan-mode");
    }
    cmd.spawn()
        .map(crate::commands::settings::spawn_and_reap)
        .map_err(|e| {
            let _ = std::fs::remove_file(&prompt_file);
            format!("spawn claudette send-chat child: {e}")
        })
}

async fn open_claudette_session_for_team_agent(
    app: AppHandle,
    workspace_id: String,
    input_json: String,
) -> Result<(), String> {
    let Some(dispatch) = build_claudette_dispatch_for_team_agent(&input_json)? else {
        return Ok(());
    };

    let state = app.state::<AppState>();
    let session =
        crate::commands::chat::session::create_chat_session(workspace_id.clone(), state).await?;
    let _ = app.emit("chat-session-created", &session);

    let state = app.state::<AppState>();
    if crate::commands::chat::session::rename_chat_session(
        session.id.clone(),
        dispatch.session_name.clone(),
        state,
    )
    .await
    .is_ok()
    {
        let _ = app.emit(
            "session-renamed",
            serde_json::json!({
                "session_id": &session.id,
                "name": dispatch.session_name,
            }),
        );
    }

    spawn_claudette_send_chat_child(
        &session.id,
        &dispatch.content,
        dispatch.model.as_deref(),
        dispatch.plan_mode,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_claudette_dispatch_for_team_agent, team_agent_session_tabs_enabled,
        write_secure_prompt_file,
    };
    use claudette::db::Database;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;

    #[test]
    fn team_agent_session_tabs_default_to_enabled() {
        let db = Database::open_in_memory().unwrap();
        assert!(team_agent_session_tabs_enabled(&db));
    }

    #[test]
    fn team_agent_session_tabs_can_be_disabled() {
        let db = Database::open_in_memory().unwrap();
        db.set_app_setting("team_agent_session_tabs_enabled", "false")
            .unwrap();
        assert!(!team_agent_session_tabs_enabled(&db));
    }

    #[test]
    fn team_agent_dispatch_builds_session_tab_prompt() {
        let dispatch = build_claudette_dispatch_for_team_agent(
            r#"{
                "description": "Read files",
                "team_name": "haiku-readers",
                "name": "haiku-reader-1",
                "model": "haiku",
                "plan_mode_required": true,
                "prompt": "Read src/main.rs"
            }"#,
        )
        .unwrap()
        .unwrap();

        assert_eq!(dispatch.session_name, "haiku-readers / haiku-reader-1");
        assert_eq!(dispatch.model.as_deref(), Some("haiku"));
        assert!(dispatch.plan_mode);
        assert!(dispatch.content.contains("Task: Read files"));
        assert!(dispatch.content.contains("teammate `haiku-reader-1`"));
        assert!(dispatch.content.contains("team `haiku-readers`"));
        assert!(dispatch.content.contains("Read src/main.rs"));
    }

    #[test]
    fn secure_prompt_file_round_trips_and_is_private() {
        let path = write_secure_prompt_file("secret prompt").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "secret prompt");
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn team_agent_dispatch_ignores_plain_subagents() {
        assert!(
            build_claudette_dispatch_for_team_agent(
                r#"{"description":"plain subagent","prompt":"do work"}"#,
            )
            .unwrap()
            .is_none()
        );
        assert!(
            build_claudette_dispatch_for_team_agent(
                r#"{"team_name":"team","name":"worker","prompt":"   "}"#,
            )
            .unwrap()
            .is_none()
        );
    }
}
