//! Output helpers shared across subcommands. Some commands have a
//! human-readable table renderer that's the default and switches to
//! JSON when `--json` is set (`workspace list`, `chat list`, `pr
//! list`/`show`, `plugin list`). Other commands always emit JSON
//! regardless of `--json` because they don't have a table renderer
//! yet (`capabilities`, `rpc`, `workspace create`/`archive`, etc.).

use std::error::Error;

/// Render anything serialisable to stdout as pretty JSON.
/// Used by `--json` output paths and JSON-only commands like
/// `capabilities` and `rpc`.
pub fn print_json(value: &serde_json::Value) -> Result<(), Box<dyn Error>> {
    let text = serde_json::to_string_pretty(value)?;
    println!("{text}");
    Ok(())
}
