//! Claude Code hook command entrypoint.
//!
//! The parent process injects this binary as a command hook. Claude Code sends
//! each hook input as JSON on stdin; this helper forwards that payload to the
//! already-running per-session bridge so the Tauri UI can show nested
//! subagent tool activity without scraping DEBUG logs.

use std::io;

use tokio::io::AsyncReadExt;

use crate::agent_mcp::protocol::{BridgePayload, BridgeRequest};

/// Run a one-shot hook forwarder.
pub async fn run_stdin() -> io::Result<()> {
    let Ok(socket_addr) = std::env::var(super::server::ENV_SOCKET_ADDR) else {
        return Ok(());
    };
    let Ok(token) = std::env::var(super::server::ENV_TOKEN) else {
        return Ok(());
    };

    let mut input = String::new();
    tokio::io::stdin().read_to_string(&mut input).await?;
    let hook_input = serde_json::from_str::<serde_json::Value>(&input)
        .map_err(|e| io::Error::other(format!("parse hook input: {e}")))?;

    let req = BridgeRequest {
        token,
        payload: BridgePayload::HookEvent { input: hook_input },
    };
    let _ = super::server::send_to_bridge(&socket_addr, &req).await;
    Ok(())
}
