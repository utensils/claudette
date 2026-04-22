pub mod agent;
pub mod cesp;
pub mod config;
pub mod db;
pub mod diff;
pub mod env;
pub mod file_expand;
pub mod fork;
pub mod git;
pub mod mcp;
pub mod mcp_supervisor;
pub mod metrics;
pub mod model;
pub mod names;
pub mod permissions;
pub mod plugin;
pub mod scm_provider;
pub mod slash_commands;
pub mod snapshot;

use base64::Engine;

pub fn base64_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

pub fn base64_decode(encoded: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::engine::general_purpose::STANDARD.decode(encoded)
}
