//! Batch manifest format and runner.
//!
//! A batch manifest is a YAML (or JSON) file that declares one
//! repository, optional defaults, and N workspaces — each with a name
//! and a prompt. `claudette batch run plan.yaml` creates each
//! workspace and dispatches its prompt to the auto-created chat
//! session.
//!
//! Schema (YAML):
//!
//! ```yaml
//! repository: my-repo            # repo name or id
//! defaults:                      # optional, applied to each workspace
//!   model: sonnet                # default model
//!   plan: false                  # default plan_mode
//! workspaces:
//!   - name: builtins-tsx
//!     prompt_file: ./prompts/43-builtins.md
//!   - name: shell-rs
//!     prompt: |                  # inline prompt, alternative to prompt_file
//!       Implement issue #42 ...
//!     model: opus                # per-workspace override
//! ```
//!
//! For now the runner creates workspaces sequentially. Parallelism
//! and `after:` dependency support are slated for a follow-up commit
//! once the basic flow is shaken out.

use std::collections::HashSet;
use std::error::Error;
use std::path::Path;

use serde::Deserialize;

use crate::{discovery, ipc};

/// Top-level manifest shape.
#[derive(Debug, Deserialize)]
pub struct Manifest {
    /// Repository name or id. Resolved at run time against the GUI's
    /// repo registry — name match wins over id when both are present
    /// (matches the pattern users naturally reach for).
    pub repository: String,
    /// Defaults applied to each workspace before per-workspace
    /// overrides. Optional.
    #[serde(default)]
    pub defaults: WorkspaceDefaults,
    /// Workspaces to create.
    pub workspaces: Vec<WorkspaceSpec>,
}

#[derive(Debug, Default, Deserialize)]
pub struct WorkspaceDefaults {
    pub model: Option<String>,
    #[serde(default)]
    pub plan: bool,
    pub permission: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceSpec {
    /// Workspace name. Must match Claudette's name validation
    /// (letters, numbers, hyphens, no leading/trailing hyphen).
    pub name: String,
    /// Inline prompt text. Mutually exclusive with `prompt_file`.
    pub prompt: Option<String>,
    /// Path to a file whose contents are the prompt body. Resolved
    /// relative to the manifest's directory. Mutually exclusive with
    /// `prompt`.
    pub prompt_file: Option<String>,
    /// Per-workspace model override. Falls back to `defaults.model`.
    pub model: Option<String>,
    /// Per-workspace plan_mode override.
    pub plan: Option<bool>,
    /// Per-workspace permission level override.
    pub permission: Option<String>,
}

/// Parse a manifest from a YAML or JSON file. The format is detected
/// by extension (`.json` → JSON, anything else → YAML). YAML is the
/// expected primary format; JSON is convenient for scripting.
pub fn load(path: &Path) -> Result<Manifest, Box<dyn Error>> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if path.extension().and_then(|s| s.to_str()) == Some("json") {
        Ok(serde_json::from_slice(&bytes)?)
    } else {
        Ok(serde_yaml::from_slice(&bytes)?)
    }
}

/// Validate a manifest without executing it. Surfaces as much as we
/// can catch statically: name conflicts, missing prompt source,
/// prompt files that don't exist on disk.
pub fn validate(manifest: &Manifest, manifest_path: &Path) -> Result<(), Box<dyn Error>> {
    if manifest.workspaces.is_empty() {
        return Err("manifest declares no workspaces".into());
    }

    let mut seen = HashSet::new();
    for spec in &manifest.workspaces {
        if !claudette::workspace_alloc::is_valid_workspace_name(&spec.name) {
            return Err(format!(
                "workspace name '{}' is invalid (must be non-empty ASCII alphanumeric + hyphens, with no leading/trailing hyphen)",
                spec.name
            )
            .into());
        }
        if !seen.insert(spec.name.as_str()) {
            return Err(format!("duplicate workspace name: '{}'", spec.name).into());
        }
        match (&spec.prompt, &spec.prompt_file) {
            (None, None) => {
                return Err(format!(
                    "workspace '{}' has neither `prompt` nor `prompt_file`",
                    spec.name
                )
                .into());
            }
            (Some(_), Some(_)) => {
                return Err(format!(
                    "workspace '{}' sets both `prompt` and `prompt_file` (pick one)",
                    spec.name
                )
                .into());
            }
            (None, Some(path_str)) => {
                let resolved = manifest_relative(manifest_path, path_str);
                if !resolved.exists() {
                    return Err(format!(
                        "workspace '{}': prompt_file does not exist: {}",
                        spec.name,
                        resolved.display()
                    )
                    .into());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Run a manifest end-to-end: resolve the repo, create each workspace
/// in order, dispatch each prompt to the auto-created session. Prints
/// a one-line status per workspace as it goes.
///
/// Sequential-only today. `--parallel N` and `after:` dependencies
/// are reserved for a follow-up commit; for the screenshot's 8-prompt
/// fan-out workflow, sequential creation is fast enough (each create
/// is sub-second once the worktree base is on a fast disk).
pub async fn run(manifest_path: &Path) -> Result<(), Box<dyn Error>> {
    let manifest = load(manifest_path)?;
    validate(&manifest, manifest_path)?;

    let info = discovery::read_app_info()?;

    // Resolve repo by name or id.
    let repos_value = ipc::call(&info, "list_repositories", serde_json::json!({})).await?;
    let repo_id = resolve_repo(&repos_value, &manifest.repository)?;

    println!(
        "batch: creating {} workspace(s) in repository {}",
        manifest.workspaces.len(),
        repo_id
    );

    let mut errors: Vec<String> = Vec::new();
    for spec in &manifest.workspaces {
        let prompt = match (&spec.prompt, &spec.prompt_file) {
            (Some(text), _) => text.clone(),
            (None, Some(p)) => {
                let path = manifest_relative(manifest_path, p);
                std::fs::read_to_string(&path)
                    .map_err(|e| format!("read prompt for '{}': {e}", spec.name))?
            }
            (None, None) => unreachable!("validate would have rejected this"),
        };
        let model = spec
            .model
            .clone()
            .or_else(|| manifest.defaults.model.clone());
        let plan = spec.plan.unwrap_or(manifest.defaults.plan);
        let permission = spec
            .permission
            .clone()
            .or_else(|| manifest.defaults.permission.clone());

        match dispatch(
            &info,
            &repo_id,
            &spec.name,
            &prompt,
            model.as_deref(),
            plan,
            permission.as_deref(),
        )
        .await
        {
            Ok(workspace_id) => {
                println!("  ✓ {} -> {}", spec.name, workspace_id);
            }
            Err(e) => {
                eprintln!("  ✗ {}: {e}", spec.name);
                errors.push(format!("{}: {e}", spec.name));
            }
        }
    }

    if !errors.is_empty() {
        return Err(format!(
            "{} workspace(s) failed:\n  {}",
            errors.len(),
            errors.join("\n  ")
        )
        .into());
    }
    println!("done");
    Ok(())
}

/// One workspace's full lifecycle: create + dispatch prompt to the
/// auto-created session. Returns the workspace id on success.
async fn dispatch(
    info: &discovery::AppInfo,
    repo_id: &str,
    name: &str,
    prompt: &str,
    model: Option<&str>,
    plan: bool,
    permission: Option<&str>,
) -> Result<String, Box<dyn Error>> {
    let create_value = ipc::call(
        info,
        "create_workspace",
        serde_json::json!({
            "repo_id": repo_id,
            "name": name,
            "preserve_name": true,
        }),
    )
    .await?;
    let workspace_id = create_value
        .get("workspace")
        .and_then(|w| w.get("id"))
        .and_then(|v| v.as_str())
        .ok_or("create_workspace response missing workspace.id")?
        .to_string();
    let session_id = create_value
        .get("default_session_id")
        .and_then(|v| v.as_str())
        .ok_or("create_workspace response missing default_session_id")?
        .to_string();

    let mut send_params = serde_json::json!({
        "session_id": session_id,
        "content": prompt,
    });
    if let Some(m) = model {
        send_params["model"] = serde_json::json!(m);
    }
    if plan {
        send_params["plan_mode"] = serde_json::json!(true);
    }
    if let Some(p) = permission {
        send_params["permission_level"] = serde_json::json!(p);
    }
    ipc::call(info, "send_chat_message", send_params).await?;
    Ok(workspace_id)
}

/// Repo resolution — accept name or id, prefer name matches when both
/// resolve.
fn resolve_repo(repos: &serde_json::Value, query: &str) -> Result<String, Box<dyn Error>> {
    let items = repos
        .as_array()
        .ok_or("list_repositories response is not an array")?;
    let mut id_match: Option<String> = None;
    for item in items {
        let id = item.get("id").and_then(|v| v.as_str());
        let name = item.get("name").and_then(|v| v.as_str());
        if name == Some(query) {
            // Name match wins immediately.
            return id
                .ok_or("matched repository missing id")
                .map(String::from)
                .map_err(Into::into);
        }
        if id == Some(query) {
            id_match = Some(query.to_string());
        }
    }
    id_match.ok_or_else(|| format!("repository '{query}' not found").into())
}

/// Resolve a path that may be relative to the manifest's directory.
/// Lets users write `prompt_file: ./prompts/foo.md` instead of repeating
/// the manifest's parent path.
fn manifest_relative(manifest_path: &Path, path: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    manifest_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(p)
}
