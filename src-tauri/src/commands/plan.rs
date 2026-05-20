use std::path::Path;

use claudette::agent_files::{AgentFileKind, classify_agent_file};

/// Read a plan file from disk and return its content.
///
/// Thin wrapper over the shared agent-file allow-list
/// ([`claudette::agent_files`]): the path must canonicalize to a `.md`
/// file under a `.claude/plans/` directory. Kept as its own command —
/// rather than folded into `read_agent_managed_file` — because
/// `PlanApprovalCard` drives it directly (including over WSS) and only
/// ever wants plan files, never memory.
#[tauri::command]
pub async fn read_plan_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (canonical, kind) = classify_agent_file(Path::new(&path))
            .map_err(|_| "Only .claude/plans/*.md files can be read".to_string())?;
        if kind != AgentFileKind::Plan {
            return Err("Only .claude/plans/*.md files can be read".to_string());
        }
        std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read plan file: {e}"))
    })
    .await
    .map_err(|e| format!("Failed to read plan file: {e}"))?
}
