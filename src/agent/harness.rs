use std::path::Path;

use crate::env::WorkspaceEnv;
use crate::env_provider::ResolvedEnv;

use super::{AgentSettings, PersistentSession};

/// Identifies the process protocol used by an agent session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentHarnessKind {
    ClaudeCode,
    CodexAppServer,
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
}
