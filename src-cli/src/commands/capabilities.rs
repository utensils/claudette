//! `claudette capabilities` — fetch the running GUI's IPC capabilities
//! record. Always prints JSON regardless of `--json` flag because the
//! contents are inherently structured. Useful for tab-completion
//! generators, MCP-style discovery, and triage.

use std::error::Error;

use crate::{discovery, ipc, output};

pub async fn run(_json: bool) -> Result<(), Box<dyn Error>> {
    let info = discovery::read_app_info()?;
    let value = ipc::call(&info, "capabilities", serde_json::json!({})).await?;
    output::print_json(&value)
}
