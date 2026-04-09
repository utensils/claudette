use std::path::Path;

/// Read a plan file from disk and return its content.
///
/// Only allows reading `.md` files whose canonicalized path lives inside a
/// `.claude/plans/` directory, preventing directory-traversal attacks.
#[tauri::command]
pub async fn read_plan_file(path: String) -> Result<String, String> {
    let canonical =
        std::fs::canonicalize(Path::new(&path)).map_err(|e| format!("Invalid plan path: {e}"))?;

    let canonical_str = canonical.to_string_lossy();
    if !canonical_str.contains(".claude/plans/") || !canonical_str.ends_with(".md") {
        return Err("Only .claude/plans/*.md files can be read".to_string());
    }

    std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read plan file: {e}"))
}
