use std::path::Path;

use crate::env::WorkspaceEnv;
use crate::env_provider::ResolvedEnv;

use super::codex_app_server::CodexAppServerSession;
use super::pi_sdk::PiSdkSession;
use super::{
    AgentEvent, AgentSettings, ControlResponsePayload, FileAttachment, PersistentSession,
    TurnHandle,
};

/// Identifies the process protocol used by an agent session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentHarnessKind {
    ClaudeCode,
    CodexAppServer,
    PiSdk,
}

/// Capabilities that affect which chat/session features a harness can support
/// without the Tauri command layer knowing provider-specific protocol details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentHarnessCapabilities {
    pub persistent_sessions: bool,
    pub steer_turn: bool,
    pub host_permission_prompts: bool,
    pub remote_control: bool,
    pub mcp_config: bool,
    pub attachments: bool,
}

impl AgentHarnessCapabilities {
    pub const fn claude_code() -> Self {
        Self {
            persistent_sessions: true,
            steer_turn: true,
            host_permission_prompts: true,
            remote_control: true,
            mcp_config: true,
            attachments: true,
        }
    }

    pub const fn codex_app_server() -> Self {
        Self {
            persistent_sessions: true,
            steer_turn: true,
            host_permission_prompts: true,
            remote_control: false,
            mcp_config: true,
            attachments: true,
        }
    }

    pub const fn pi_sdk() -> Self {
        Self {
            persistent_sessions: true,
            steer_turn: true,
            host_permission_prompts: true,
            remote_control: false,
            mcp_config: false,
            attachments: false,
        }
    }
}

/// Borrowed spawn parameters for a persistent agent session. This keeps the
/// call boundary harness-neutral while preserving the existing Claude Code
/// spawn inputs exactly.
#[derive(Debug)]
pub struct PersistentSessionStart<'a> {
    pub working_dir: &'a Path,
    pub session_id: &'a str,
    pub is_resume: bool,
    pub allowed_tools: &'a [String],
    pub custom_instructions: Option<&'a str>,
    pub settings: &'a AgentSettings,
    pub workspace_env: Option<&'a WorkspaceEnv>,
    pub resolved_env: Option<&'a ResolvedEnv>,
}

/// Adapter for the existing Claude Code stream-json process protocol.
pub struct ClaudeCodeHarness;

impl ClaudeCodeHarness {
    pub const KIND: AgentHarnessKind = AgentHarnessKind::ClaudeCode;
    pub const CAPABILITIES: AgentHarnessCapabilities = AgentHarnessCapabilities::claude_code();

    pub async fn start_persistent(
        params: PersistentSessionStart<'_>,
    ) -> Result<PersistentSession, String> {
        PersistentSession::start(
            params.working_dir,
            params.session_id,
            params.is_resume,
            params.allowed_tools,
            params.custom_instructions,
            params.settings,
            params.workspace_env,
            params.resolved_env,
        )
        .await
    }
}

/// Long-lived session handle owned by the app layer.
///
/// This is intentionally an enum instead of a trait object for the first
/// refactor step: it keeps dispatch explicit, lets each harness expose only the
/// operations it supports, and avoids async-trait plumbing while Claude Code is
/// still the only production variant.
pub enum AgentSession {
    ClaudeCode(PersistentSession),
    CodexAppServer(CodexAppServerSession),
    PiSdk(PiSdkSession),
}

impl AgentSession {
    pub fn from_claude_code(session: PersistentSession) -> Self {
        Self::ClaudeCode(session)
    }

    pub fn from_codex_app_server(session: CodexAppServerSession) -> Self {
        Self::CodexAppServer(session)
    }

    pub fn from_pi_sdk(session: PiSdkSession) -> Self {
        Self::PiSdk(session)
    }

    pub fn kind(&self) -> AgentHarnessKind {
        match self {
            Self::ClaudeCode(_) => AgentHarnessKind::ClaudeCode,
            Self::CodexAppServer(_) => AgentHarnessKind::CodexAppServer,
            Self::PiSdk(_) => AgentHarnessKind::PiSdk,
        }
    }

    pub fn capabilities(&self) -> AgentHarnessCapabilities {
        match self {
            Self::ClaudeCode(_) => AgentHarnessCapabilities::claude_code(),
            Self::CodexAppServer(_) => AgentHarnessCapabilities::codex_app_server(),
            Self::PiSdk(_) => AgentHarnessCapabilities::pi_sdk(),
        }
    }

    pub fn pid(&self) -> u32 {
        match self {
            Self::ClaudeCode(session) => session.pid(),
            Self::CodexAppServer(session) => session.pid(),
            Self::PiSdk(session) => session.pid(),
        }
    }

    pub async fn send_turn_with_uuid(
        &self,
        prompt: &str,
        attachments: &[FileAttachment],
        user_message_uuid: &str,
    ) -> Result<TurnHandle, String> {
        match self {
            Self::ClaudeCode(session) => {
                session
                    .send_turn_with_uuid(prompt, attachments, user_message_uuid)
                    .await
            }
            Self::CodexAppServer(session) => session.send_turn(prompt, attachments).await,
            Self::PiSdk(session) => session.send_turn(prompt, attachments).await,
        }
    }

    pub async fn steer_user_message(
        &self,
        prompt: &str,
        attachments: &[FileAttachment],
    ) -> Result<(), String> {
        match self {
            Self::ClaudeCode(session) => session.steer_user_message(prompt, attachments).await,
            Self::CodexAppServer(session) => session.steer_turn(prompt, attachments).await,
            Self::PiSdk(session) => session.steer_turn(prompt, attachments).await,
        }
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<AgentEvent> {
        match self {
            Self::ClaudeCode(session) => session.subscribe(),
            Self::CodexAppServer(session) => session.subscribe(),
            Self::PiSdk(session) => session.subscribe(),
        }
    }

    pub async fn send_control_response(
        &self,
        request_id: &str,
        response: serde_json::Value,
    ) -> Result<(), String> {
        match self {
            Self::ClaudeCode(session) => session.send_control_response(request_id, response).await,
            Self::CodexAppServer(session) => {
                session.send_control_response(request_id, response).await
            }
            Self::PiSdk(session) => session.send_control_response(request_id, response).await,
        }
    }

    pub async fn send_task_stop(&self, task_id: &str) -> Result<(), String> {
        match self {
            Self::ClaudeCode(session) => session.send_task_stop(task_id).await,
            Self::CodexAppServer(_) => {
                Err(format!("Codex app-server cannot stop task `{task_id}` yet"))
            }
            Self::PiSdk(_) => Err(format!("Pi SDK harness cannot stop task `{task_id}` yet")),
        }
    }

    pub async fn interrupt_turn(&self) -> Result<(), String> {
        match self {
            Self::ClaudeCode(session) => super::process::stop_agent(session.pid()).await,
            Self::CodexAppServer(session) => session.interrupt_turn().await,
            Self::PiSdk(session) => session.interrupt_turn().await,
        }
    }

    pub async fn set_remote_control(
        &self,
        enabled: bool,
    ) -> Result<ControlResponsePayload, String> {
        match self {
            Self::ClaudeCode(session) => session.set_remote_control(enabled).await,
            Self::CodexAppServer(_) => {
                Err("Codex app-server does not support Claude Remote Control".to_string())
            }
            Self::PiSdk(_) => {
                Err("Pi SDK harness does not support Claude Remote Control".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_harness_preserves_current_capabilities() {
        assert_eq!(ClaudeCodeHarness::KIND, AgentHarnessKind::ClaudeCode);
        assert_eq!(
            ClaudeCodeHarness::CAPABILITIES,
            AgentHarnessCapabilities {
                persistent_sessions: true,
                steer_turn: true,
                host_permission_prompts: true,
                remote_control: true,
                mcp_config: true,
                attachments: true,
            }
        );
    }

    #[test]
    fn codex_app_server_capabilities_are_harness_specific() {
        assert_eq!(
            AgentHarnessCapabilities::codex_app_server(),
            AgentHarnessCapabilities {
                persistent_sessions: true,
                steer_turn: true,
                host_permission_prompts: true,
                remote_control: false,
                mcp_config: true,
                attachments: true,
            }
        );
    }

    #[test]
    fn pi_sdk_capabilities_are_harness_specific() {
        assert_eq!(
            AgentHarnessCapabilities::pi_sdk(),
            AgentHarnessCapabilities {
                persistent_sessions: true,
                steer_turn: true,
                host_permission_prompts: true,
                remote_control: false,
                mcp_config: false,
                attachments: false,
            }
        );
    }

    #[test]
    fn agent_session_capabilities_stay_explicit_per_variant() {
        assert!(AgentHarnessCapabilities::claude_code().remote_control);
        assert!(!AgentHarnessCapabilities::codex_app_server().remote_control);
        assert!(!AgentHarnessCapabilities::pi_sdk().remote_control);
    }

    #[test]
    fn codex_agent_session_reports_native_kind_and_capabilities() {
        let session =
            AgentSession::from_codex_app_server(CodexAppServerSession::new_for_test(1234));

        assert_eq!(session.kind(), AgentHarnessKind::CodexAppServer);
        assert_eq!(session.pid(), 1234);
        assert_eq!(
            session.capabilities(),
            AgentHarnessCapabilities::codex_app_server()
        );
    }

    #[test]
    fn pi_agent_session_reports_native_kind_and_capabilities() {
        let session = AgentSession::from_pi_sdk(PiSdkSession::new_for_test(5678));

        assert_eq!(session.kind(), AgentHarnessKind::PiSdk);
        assert_eq!(session.pid(), 5678);
        assert_eq!(session.capabilities(), AgentHarnessCapabilities::pi_sdk());
    }
}
