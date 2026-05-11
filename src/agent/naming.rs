use std::io::Write as _;
use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::env::WorkspaceEnv;
use crate::process::{CommandWindowExt as _, sanitize_claude_subprocess_env};

use super::binary::resolve_claude_path;

const CLAUDE_PROJECT_PATH_MAX: usize = 200;

/// Sanitize a string into a valid git branch slug: lowercase ASCII
/// alphanumeric + hyphens, no leading/trailing hyphens, max `max_len` chars.
pub fn sanitize_branch_name(raw: &str, max_len: usize) -> String {
    let slug: String = raw
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();

    // Collapse consecutive hyphens.
    let mut collapsed = String::with_capacity(slug.len());
    let mut prev_hyphen = false;
    for c in slug.chars() {
        if c == '-' {
            if !prev_hyphen {
                collapsed.push(c);
            }
            prev_hyphen = true;
        } else {
            collapsed.push(c);
            prev_hyphen = false;
        }
    }

    // Trim leading/trailing hyphens, truncate.
    let trimmed = collapsed.trim_matches('-');
    if trimmed.len() <= max_len {
        return trimmed.to_string();
    }
    // Truncate at `max_len` and drop any trailing hyphens introduced by the cut.
    let truncated = &trimmed[..max_len];
    truncated.trim_end_matches('-').to_string()
}

fn sanitize_claude_project_path(path: &str) -> String {
    let sanitized: String = path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if sanitized.len() <= CLAUDE_PROJECT_PATH_MAX {
        return sanitized;
    }
    let mut hash: u64 = 5381;
    for b in path.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(u64::from(b));
    }
    // The masked hash is 31 bits, formatted as up to 8 lowercase hex digits;
    // with the joining `-` that's a 9-char suffix. Reserve room so the final
    // string honors the documented cap (otherwise long paths produce up to
    // CLAUDE_PROJECT_PATH_MAX + 9 chars and the constant becomes a lie).
    const SUFFIX_RESERVED: usize = 9;
    let prefix_max = CLAUDE_PROJECT_PATH_MAX.saturating_sub(SUFFIX_RESERVED);
    format!("{}-{:x}", &sanitized[..prefix_max], hash & 0x7fff_ffff)
}

fn claude_config_home_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    dirs::home_dir()
        .map(|home| home.join(".claude"))
        .ok_or_else(|| "No home directory found for Claude config".to_string())
}

fn claude_transcript_path(worktree_path: &str, session_id: &str) -> Result<PathBuf, String> {
    Ok(claude_config_home_dir()?
        .join("projects")
        .join(sanitize_claude_project_path(worktree_path))
        .join(format!("{session_id}.jsonl")))
}

/// Persist a Claude Code custom title for a session transcript.
///
/// Claude Code's Remote Control bridge treats custom titles as explicit and
/// stops its count-based web title derivation. Claudette uses this to keep
/// the remote session title aligned with the local chat instead of letting the
/// web UI retitle on later mixed local/remote turns.
pub fn persist_claude_custom_title(
    worktree_path: &str,
    session_id: &str,
    title: &str,
) -> Result<(), String> {
    persist_claude_custom_title_at_path(
        &claude_transcript_path(worktree_path, session_id)?,
        session_id,
        title,
    )
}

fn persist_claude_custom_title_at_path(
    path: &Path,
    session_id: &str,
    title: &str,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() || session_id.trim().is_empty() {
        return Ok(());
    }
    if !path.exists() {
        return Ok(());
    }
    if transcript_has_custom_title(path, session_id)? {
        return Ok(());
    }
    let entry = serde_json::json!({
        "type": "custom-title",
        "customTitle": title,
        "sessionId": session_id,
    });
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open Claude transcript {}: {e}", path.display()))?;
    writeln!(file, "{entry}").map_err(|e| {
        format!(
            "Failed to write Claude custom title {}: {e}",
            path.display()
        )
    })
}

fn transcript_has_custom_title(path: &Path, session_id: &str) -> Result<bool, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read Claude transcript {}: {e}", path.display()))?;
    for line in contents.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("custom-title")
            && value.get("sessionId").and_then(|v| v.as_str()) == Some(session_id)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Call Claude Haiku to generate a short branch name slug from the user's
/// first prompt. Returns a sanitized branch slug (e.g. `fix-login-timeout`).
///
/// `worktree_path` is used as the subprocess CWD so the CLI picks up the
/// user's git context and `ws_env`-resolved env vars, but project context
/// (CLAUDE.md, `.mcp.json`, project `.claude/settings.json`) is intentionally
/// suppressed via `--system-prompt`, `--setting-sources user`, and
/// `--tools ""`. A user project's CLAUDE.md plus MCP tool catalog can easily
/// exceed Haiku's input window, and slug generation doesn't need that context.
pub async fn generate_branch_name(
    prompt_text: &str,
    worktree_path: &str,
    branch_rename_preferences: Option<&str>,
    ws_env: Option<&WorkspaceEnv>,
) -> Result<String, String> {
    // Truncate prompt to keep the Haiku call fast and cheap.
    let truncated: String = prompt_text.chars().take(200).collect();

    // Pre-check the working directory exists — a deleted worktree would
    // otherwise surface as a misleading MISSING_CLI sentinel (see
    // [`crate::missing_cli`] module docs).
    crate::missing_cli::precheck_cwd(std::path::Path::new(worktree_path))?;

    let claude_path = resolve_claude_path().await;
    let mut cmd = Command::new(&claude_path);
    cmd.no_console_window();
    cmd.stdin(std::process::Stdio::null())
        .env("PATH", crate::env::enriched_path());
    cmd.current_dir(worktree_path);
    let user_message = format!(
        "Generate a short git branch name slug for the following task. \
         Output ONLY the slug — no explanation, no markdown, no quotes. \
         Lowercase letters, numbers, and hyphens only. Max 30 chars.\n\n\
         Task: {truncated}"
    );
    let mut system_prompt =
        "You are a branch name generator. Output ONLY a slug. Never answer the task itself."
            .to_string();
    if let Some(prefs) = branch_rename_preferences {
        let prefs_truncated: String = prefs.chars().take(500).collect();
        system_prompt.push_str(&format!(
            "\n\nThe user has provided the following branch naming preferences. \
             Prioritize these over your default behavior:\n{prefs_truncated}"
        ));
    }
    cmd.args([
        "--print",
        "--output-format",
        "text",
        "--model",
        "claude-haiku-4-5",
        // Replace the default system prompt instead of appending so the CLI
        // skips CLAUDE.md auto-discovery — user project context can exceed
        // Haiku's input window, and slug generation doesn't need it.
        "--system-prompt",
        &system_prompt,
        // Skip project + local settings so the CLI doesn't pull in
        // `.mcp.json` tool catalogs or `.claude/settings.json` overrides.
        "--setting-sources",
        "user",
        // No tools needed for a one-shot slug — keeps the system prompt
        // free of tool definitions.
        "--tools",
        "",
        &user_message,
    ]);

    sanitize_claude_subprocess_env(&mut cmd);

    if let Some(env) = ws_env {
        env.apply(&mut cmd);
    }

    let output = cmd.output().await.map_err(|e| {
        crate::missing_cli::map_spawn_err(&e, "claude", || {
            format!("Failed to spawn claude at {claude_path:?} for branch name: {e}")
        })
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Haiku branch name call failed: {stderr}"));
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let slug = sanitize_branch_name(&raw, 30);
    if slug.is_empty() {
        return Err(format!(
            "Haiku returned empty or unsanitizable output: {raw:?}"
        ));
    }
    Ok(slug)
}

/// Ask Haiku for a short, human-readable name for a chat session based on the
/// user's first prompt. Output is meant for display in a tab, e.g. "Auth flow
/// refactor". 3–6 words, title-case friendly, no slug formatting.
pub async fn generate_session_name(
    prompt_text: &str,
    worktree_path: &str,
    ws_env: Option<&WorkspaceEnv>,
) -> Result<String, String> {
    let truncated: String = prompt_text.chars().take(200).collect();

    // Pre-check the working directory exists — see naming.rs sibling and
    // [`crate::missing_cli`] module docs.
    crate::missing_cli::precheck_cwd(std::path::Path::new(worktree_path))?;

    let claude_path = resolve_claude_path().await;
    let mut cmd = Command::new(&claude_path);
    cmd.stdin(std::process::Stdio::null())
        .env("PATH", crate::env::enriched_path());
    cmd.current_dir(worktree_path);

    let user_message = format!(
        "Generate a short, human-readable name for this chat session based on \
         the user's first message. 3-6 words. No quotes, no markdown, no \
         trailing punctuation. Prefer nouns over verbs.\n\n\
         Message: {truncated}"
    );
    let system_prompt = "You are a chat-session namer. Output ONLY a short \
         descriptive name — never answer or complete the task itself."
        .to_string();
    // Same context-suppression flags as `generate_branch_name` above — see
    // that function's doc comment for the rationale. A user project's
    // CLAUDE.md + MCP tool catalog can overflow Haiku's input window and
    // session-name generation doesn't need that context either.
    cmd.args([
        "--print",
        "--output-format",
        "text",
        "--model",
        "claude-haiku-4-5",
        "--system-prompt",
        &system_prompt,
        "--setting-sources",
        "user",
        "--tools",
        "",
        &user_message,
    ]);

    sanitize_claude_subprocess_env(&mut cmd);

    if let Some(env) = ws_env {
        env.apply(&mut cmd);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn claude at {claude_path:?} for session name: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Haiku session name call failed: {stderr}"));
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // Strip surrounding quotes if Haiku adds them despite the instruction.
    let trimmed = raw.trim_matches(|c: char| c == '"' || c == '\'').trim();
    // Cap length defensively — tabs truncate visually, but 60 is a hard cap.
    let capped: String = trimmed.chars().take(60).collect();
    if capped.is_empty() {
        return Err(format!("Haiku returned empty session name: {raw:?}"));
    }
    Ok(capped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_simple_slug() {
        assert_eq!(sanitize_branch_name("fix-login-bug", 40), "fix-login-bug");
    }

    #[test]
    fn test_sanitize_uppercase_and_spaces() {
        assert_eq!(
            sanitize_branch_name("Fix Login Timeout", 40),
            "fix-login-timeout"
        );
    }

    #[test]
    fn test_sanitize_special_characters() {
        assert_eq!(
            sanitize_branch_name("add CSV export!!", 40),
            "add-csv-export"
        );
    }

    #[test]
    fn test_sanitize_consecutive_hyphens() {
        assert_eq!(
            sanitize_branch_name("fix---multiple---hyphens", 40),
            "fix-multiple-hyphens"
        );
    }

    #[test]
    fn test_sanitize_leading_trailing_hyphens() {
        assert_eq!(
            sanitize_branch_name("--leading-and-trailing--", 40),
            "leading-and-trailing"
        );
    }

    #[test]
    fn test_sanitize_truncation() {
        let long_input = "this-is-a-very-long-branch-name-that-exceeds-the-limit";
        let result = sanitize_branch_name(long_input, 20);
        assert!(result.len() <= 20);
        assert!(!result.ends_with('-'));
    }

    #[test]
    fn test_sanitize_empty_input() {
        assert_eq!(sanitize_branch_name("", 40), "");
    }

    #[test]
    fn test_sanitize_all_special_chars() {
        assert_eq!(sanitize_branch_name("!@#$%", 40), "");
    }

    #[test]
    fn test_sanitize_preserves_numbers() {
        assert_eq!(sanitize_branch_name("fix-issue-42", 40), "fix-issue-42");
    }

    #[test]
    fn test_sanitize_claude_project_path_matches_claude_layout() {
        assert_eq!(
            sanitize_claude_project_path("/Users/james/claudette-workspaces/repo-name"),
            "-Users-james-claudette-workspaces-repo-name"
        );
    }

    #[test]
    fn test_sanitize_claude_project_path_honors_max_with_hash_suffix() {
        // Long path that triggers the hash branch — output must include the
        // hash AND stay within CLAUDE_PROJECT_PATH_MAX (200). Before the
        // SUFFIX_RESERVED fix the result was up to 209 chars.
        let long_path = format!("/Users/{}", "a".repeat(300));
        let sanitized = sanitize_claude_project_path(&long_path);
        assert!(
            sanitized.len() <= CLAUDE_PROJECT_PATH_MAX,
            "expected sanitized len {} <= {}",
            sanitized.len(),
            CLAUDE_PROJECT_PATH_MAX,
        );
        // Hash suffix is `-` + up to 8 hex chars; verify the format actually
        // appended one (otherwise a regression that drops the suffix would
        // pass the length assertion above by accident).
        let last_dash = sanitized.rfind('-').unwrap();
        let suffix = &sanitized[last_dash + 1..];
        assert!(!suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_persist_claude_custom_title_does_not_create_missing_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("missing.jsonl");

        persist_claude_custom_title_at_path(&transcript, "session-1", "Pinned Title").unwrap();

        assert!(!transcript.exists());
    }

    #[test]
    fn test_persist_claude_custom_title_appends_to_existing_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("session-1.jsonl");
        std::fs::write(
            &transcript,
            r#"{"type":"summary","summary":"existing transcript"}"#,
        )
        .unwrap();

        persist_claude_custom_title_at_path(&transcript, "session-1", "Pinned Title").unwrap();

        let contents = std::fs::read_to_string(transcript).unwrap();
        assert!(contents.contains(r#""type":"custom-title""#));
        assert!(contents.contains(r#""customTitle":"Pinned Title""#));
        assert!(contents.contains(r#""sessionId":"session-1""#));
    }

    #[test]
    fn test_persist_claude_custom_title_keeps_first_title() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("session-1.jsonl");
        std::fs::write(
            &transcript,
            r#"{"type":"custom-title","customTitle":"First Title","sessionId":"session-1"}"#,
        )
        .unwrap();

        persist_claude_custom_title_at_path(&transcript, "session-1", "Second Title").unwrap();

        let contents = std::fs::read_to_string(transcript).unwrap();
        assert!(contents.contains(r#""customTitle":"First Title""#));
        assert!(!contents.contains(r#""customTitle":"Second Title""#));
    }
}
