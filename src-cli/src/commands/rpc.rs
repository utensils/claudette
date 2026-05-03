//! `claudette rpc <method> [params]` — raw JSON-RPC escape hatch.
//!
//! Mirrors `cmux rpc`. Lets users invoke any method the IPC server
//! exposes (use `claudette capabilities` to discover them) without
//! waiting for a typed subcommand to ship. `params` is parsed as
//! arbitrary JSON; if it's not valid JSON the error message includes
//! the position so users can fix their quoting.

use std::error::Error;

use crate::{discovery, ipc, output};

pub async fn run(method: &str, params: &str, _json: bool) -> Result<(), Box<dyn Error>> {
    let params_value: serde_json::Value = serde_json::from_str(params)
        .map_err(|e| format!("params is not valid JSON: {e} (input: {params})"))?;
    let info = discovery::read_app_info()?;
    let value = ipc::call(&info, method, params_value).await?;
    output::print_json(&value)
}
