//! Output helpers shared across subcommands. The CLI defaults to
//! human-readable table-style output and switches to JSON when `--json`
//! is set.

use std::error::Error;

/// Render anything serialisable to stdout as pretty JSON.
/// Used by `--json` output paths and JSON-only commands like
/// `capabilities` and `rpc`.
pub fn print_json(value: &serde_json::Value) -> Result<(), Box<dyn Error>> {
    let text = serde_json::to_string_pretty(value)?;
    println!("{text}");
    Ok(())
}
