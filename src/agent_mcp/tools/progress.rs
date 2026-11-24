//! User-facing annotations on an existing subagent run. The bridge supplies
//! the chat session and harness. A report cannot create or finish a worker.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const NAME: &str = "report_agent_progress";
pub(crate) const CLAUDE_TOOL_NAME: &str = "mcp__claudette__report_agent_progress";
pub const GUIDANCE: &str = "When delegated work reaches a meaningful milestone, needs user input, or produces a result, use the Claudette MCP tool `report_agent_progress` with the known child run ID and one short, user-facing summary. The parent can report for a child. Routine tool activity needs no report.";

const MAX_SUMMARY: usize = 512;
const MAX_ID: usize = 512;

/// Claude's dynamically supplied server takes precedence over a same-named
/// project server. Grant the single reporting tool only if this launch
/// supplies our executable and this hook bridge's private socket credentials.
pub(crate) fn has_trusted_claude_entry(
    config: Option<&str>,
    bridge: &crate::agent::AgentHookBridge,
) -> bool {
    use crate::agent_mcp::server::{ENV_SOCKET_ADDR, ENV_TOKEN, SERVER_NAME};

    let Some(config) = config.and_then(|s| serde_json::from_str::<Value>(s).ok()) else {
        return false;
    };
    let server = &config["mcpServers"][SERVER_NAME];
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    server["type"] == "stdio"
        && server["command"].as_str() == Some(exe.to_string_lossy().as_ref())
        && server["args"] == json!(["--agent-mcp"])
        && server["env"][ENV_SOCKET_ADDR].as_str() == Some(&bridge.socket_addr)
        && server["env"][ENV_TOKEN].as_str() == Some(&bridge.token)
}

pub fn definition() -> Value {
    json!({
        "name": NAME,
        "description": GUIDANCE,
        "inputSchema": {
            "type": "object",
            "properties": {
                "run_id": { "type": "string", "minLength": 1, "maxLength": MAX_ID, "description": "The agent ID returned by the delegation (Codex child thread ID, Claude agent ID, or Antigravity child session ID). For an Antigravity delegation from the main session with no child ID, use its originating tool call ID." },
                "kind": { "type": "string", "enum": ["milestone", "blocked", "result"] },
                "summary": { "type": "string", "minLength": 1, "maxLength": MAX_SUMMARY, "description": "One sentence explaining what changed or what input is needed." }
            },
            "required": ["run_id", "kind", "summary"],
            "additionalProperties": false
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProgressReport {
    pub run_id: String,
    pub kind: ReportKind,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportKind {
    Milestone,
    Blocked,
    Result,
}

impl ReportKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Milestone => "milestone",
            Self::Blocked => "blocked",
            Self::Result => "result",
        }
    }
}

impl ProgressReport {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.run_id.trim().is_empty() || self.run_id.chars().count() > MAX_ID {
            return Err("Provide a known child run ID, up to 512 characters.");
        }
        if self.summary.trim().is_empty() || self.summary.chars().count() > MAX_SUMMARY {
            return Err("Provide a progress summary of 1 to 512 characters.");
        }
        Ok(())
    }
}
