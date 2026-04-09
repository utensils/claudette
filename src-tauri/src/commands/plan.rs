use std::path::Path;

/// Read a plan file from disk and return its content.
///
/// Validates via path components that the canonicalized path contains a
/// `.claude/plans/` directory and ends with `.md`.
#[tauri::command]
pub async fn read_plan_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = std::fs::canonicalize(Path::new(&path))
            .map_err(|e| format!("Invalid plan path: {e}"))?;

        // Validate via path components: must have consecutive .claude → plans segments.
        let components: Vec<&str> = canonical
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect();
        let has_plans_dir = components
            .windows(2)
            .any(|w| w[0] == ".claude" && w[1] == "plans");

        if !has_plans_dir || canonical.extension().and_then(|e| e.to_str()) != Some("md") {
            return Err("Only .claude/plans/*.md files can be read".to_string());
        }

        std::fs::read_to_string(&canonical).map_err(|e| format!("Failed to read plan file: {e}"))
    })
    .await
    .map_err(|e| format!("Failed to read plan file: {e}"))?
}
