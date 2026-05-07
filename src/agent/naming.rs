use tokio::process::Command;

use crate::env::WorkspaceEnv;
use crate::process::CommandWindowExt as _;

use super::binary::resolve_claude_path;

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

/// Call Claude Haiku to generate a short branch name slug from the user's
/// first prompt. Returns a sanitized branch slug (e.g. `fix-login-timeout`).
/// `worktree_path` sets the subprocess CWD so the CLI picks up the correct
/// project context (CLAUDE.md) for the user's workspace — not Claudette's own.
pub async fn generate_branch_name(
    prompt_text: &str,
    worktree_path: &str,
    branch_rename_preferences: Option<&str>,
    ws_env: Option<&WorkspaceEnv>,
) -> Result<String, String> {
    // Truncate prompt to keep the Haiku call fast and cheap.
    let truncated: String = prompt_text.chars().take(200).collect();

    let claude_path = resolve_claude_path().await;
    let mut cmd = Command::new(&claude_path);
    cmd.no_console_window();
    cmd.stdin(std::process::Stdio::null())
        .env("PATH", crate::env::enriched_path());
    // Run in the user's worktree so the CLI loads *their* project context.
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
        "--append-system-prompt",
        &system_prompt,
        &user_message,
    ]);

    // Strip env vars that interfere with subprocess auth — same as run_turn.
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY")
        && !key.starts_with("sk-ant-api")
    {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

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
    cmd.args([
        "--print",
        "--output-format",
        "text",
        "--model",
        "claude-haiku-4-5",
        "--append-system-prompt",
        &system_prompt,
        &user_message,
    ]);

    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY")
        && !key.starts_with("sk-ant-api")
    {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

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
}
