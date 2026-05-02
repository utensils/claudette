/// Developer-bundled system prompt injected into every agent session.
/// Edit `src/global-system-prompt.md` to update the content — changes take
/// effect after a rebuild (the string is compiled in via `include_str!`).
pub const GLOBAL_SYSTEM_PROMPT: &str = include_str!("global-system-prompt.md");

/// Compose the final `--append-system-prompt` value for a fresh agent
/// session. Layers from outermost to innermost: bundled global prompt → MCP
/// nudge (when `send_to_user` is enabled) → per-repo instructions. Each
/// layer is dropped when empty or whitespace-only. Returns `None` when no
/// layer contributes content, so the caller can skip the CLI flag entirely
/// rather than pass an empty string.
///
/// Resume turns reuse the persistent CLI process and never re-pass
/// `--append-system-prompt`, so this composition only matters on fresh
/// spawns.
pub fn compose_system_prompt(
    repo_instructions: Option<&str>,
    nudge: Option<&str>,
) -> Option<String> {
    compose_with_global(GLOBAL_SYSTEM_PROMPT, repo_instructions, nudge)
}

fn compose_with_global(
    global: &str,
    repo_instructions: Option<&str>,
    nudge: Option<&str>,
) -> Option<String> {
    let mut parts: Vec<&str> = Vec::with_capacity(3);
    if !global.trim().is_empty() {
        parts.push(global);
    }
    if let Some(n) = nudge
        && !n.trim().is_empty()
    {
        parts.push(n);
    }
    if let Some(repo) = repo_instructions
        && !repo.trim().is_empty()
    {
        parts.push(repo);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_everything_returns_none() {
        assert_eq!(compose_with_global("", None, None), None);
    }

    #[test]
    fn whitespace_only_layers_treated_as_empty() {
        assert_eq!(
            compose_with_global("  \n\t  ", Some("\n\n"), Some("   ")),
            None
        );
    }

    #[test]
    fn global_only() {
        assert_eq!(
            compose_with_global("GLOBAL", None, None),
            Some("GLOBAL".to_string())
        );
    }

    #[test]
    fn nudge_only() {
        assert_eq!(
            compose_with_global("", None, Some("NUDGE")),
            Some("NUDGE".to_string())
        );
    }

    #[test]
    fn repo_only() {
        assert_eq!(
            compose_with_global("", Some("REPO"), None),
            Some("REPO".to_string())
        );
    }

    #[test]
    fn all_three_in_priority_order() {
        assert_eq!(
            compose_with_global("GLOBAL", Some("REPO"), Some("NUDGE")),
            Some("GLOBAL\n\nNUDGE\n\nREPO".to_string())
        );
    }

    #[test]
    fn global_and_repo_no_nudge() {
        assert_eq!(
            compose_with_global("GLOBAL", Some("REPO"), None),
            Some("GLOBAL\n\nREPO".to_string())
        );
    }

    #[test]
    fn nudge_and_repo_no_global() {
        assert_eq!(
            compose_with_global("", Some("REPO"), Some("NUDGE")),
            Some("NUDGE\n\nREPO".to_string())
        );
    }

    #[test]
    fn public_api_uses_bundled_constant() {
        // Concrete content is intentionally not asserted to keep this test
        // stable across edits to `global-system-prompt.md`.
        let composed = compose_system_prompt(Some("REPO"), None).unwrap();
        assert!(composed.contains("REPO"));
        assert!(composed.starts_with(GLOBAL_SYSTEM_PROMPT.trim_end()));
    }
}
