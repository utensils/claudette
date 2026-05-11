use tauri::{AppHandle, Emitter};

use claudette::agent;
use claudette::db::Database;
use claudette::env::WorkspaceEnv;
use claudette::git;

/// Background task: generate a descriptive branch name via Haiku and rename
/// the workspace's branch + DB record. All failures are non-fatal.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn try_auto_rename(
    ws_id: &str,
    worktree_path: &str,
    old_name: &str,
    old_branch: &str,
    prompt: &str,
    branch_rename_preferences: Option<&str>,
    db_path: &std::path::Path,
    app: &AppHandle,
    ws_env: &WorkspaceEnv,
) {
    // Ask Haiku for a branch name slug.
    let slug = match agent::generate_branch_name(
        prompt,
        worktree_path,
        branch_rename_preferences,
        Some(ws_env),
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                target: "claudette::chat",
                workspace_id = %ws_id,
                error = %e,
                "auto-rename: generate_branch_name failed",
            );
            return;
        }
    };

    // Resolve the configured branch prefix.
    let prefix = {
        let db = match Database::open(db_path) {
            Ok(db) => db,
            Err(e) => {
                tracing::warn!(
                    target: "claudette::chat",
                    workspace_id = %ws_id,
                    error = %e,
                    "auto-rename: Database::open failed (reading branch prefix)",
                );
                return;
            }
        };
        let (mode, custom) = claudette::ops::workspace::read_branch_prefix_settings(&db);
        // Drop db before the async call (Database is not Sync).
        drop(db);
        claudette::ops::workspace::resolve_branch_prefix(&mode, &custom).await
    };

    // Try the slug, then slug-2, slug-3 on name collision.
    let candidates = [slug.clone(), format!("{slug}-2"), format!("{slug}-3")];
    for candidate in &candidates {
        let new_branch = format!("{prefix}{candidate}");

        let db = match Database::open(db_path) {
            Ok(db) => db,
            Err(e) => {
                tracing::warn!(
                    target: "claudette::chat",
                    workspace_id = %ws_id,
                    error = %e,
                    "auto-rename: Database::open failed (renaming workspace)",
                );
                return;
            }
        };

        match db.rename_workspace(ws_id, candidate, &new_branch) {
            Ok(()) => {
                // DB updated — now rename the git branch.
                if let Err(e) = git::rename_branch(worktree_path, old_branch, &new_branch).await {
                    let _ = db.rename_workspace(ws_id, old_name, old_branch);

                    // If the target branch already exists, fall back to the next
                    // candidate just like we do for DB unique constraint collisions.
                    if e.to_string().contains("already exists") {
                        continue;
                    }
                    tracing::warn!(
                        target: "claudette::chat",
                        workspace_id = %ws_id,
                        error = %e,
                        new_branch = %new_branch,
                        "auto-rename: git rename_branch failed",
                    );
                    return;
                }

                // Success — notify the frontend.
                let payload = serde_json::json!({
                    "workspace_id": ws_id,
                    "name": candidate,
                    "branch_name": new_branch,
                });
                let _ = app.emit("workspace-renamed", &payload);
                return;
            }
            Err(e) => {
                if e.to_string().contains("UNIQUE constraint failed") {
                    continue;
                }
                tracing::warn!(
                    target: "claudette::chat",
                    workspace_id = %ws_id,
                    error = %e,
                    candidate = %candidate,
                    "auto-rename: db.rename_workspace failed",
                );
                return;
            }
        }
    }

    // All candidate slugs collided. Without this log the workspace silently
    // stays on its placeholder name and the one-shot claim makes it
    // unrecoverable on later turns.
    tracing::warn!(
        target: "claudette::chat",
        workspace_id = %ws_id,
        slug = %slug,
        "auto-rename: all candidate slugs collided",
    );
}

/// Background task: ask Haiku for a short session name and persist it. All
/// failures are non-fatal — if Haiku is unavailable or the user has already
/// renamed the session, the `New chat` default stays in place.
pub(crate) async fn try_generate_session_name(
    session_id: &str,
    worktree_path: &str,
    prompt: &str,
    db_path: &std::path::Path,
    app: &AppHandle,
    ws_env: &WorkspaceEnv,
) {
    let name = match agent::generate_session_name(prompt, worktree_path, Some(ws_env)).await {
        Ok(n) => n,
        Err(_) => return,
    };

    let db = match Database::open(db_path) {
        Ok(db) => db,
        Err(_) => return,
    };

    // The helper only writes when `name_edited == 0`, so a concurrent user
    // rename between spawn and write is handled correctly — we become a no-op.
    if let Ok(true) = db.set_session_name_from_haiku(session_id, &name) {
        let payload = serde_json::json!({
            "session_id": session_id,
            "name": name,
        });
        let _ = app.emit("session-renamed", &payload);
    }
}
