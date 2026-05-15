/// Developer-bundled system prompt injected into every agent session.
/// Edit `src/global-system-prompt.md` to update the content — changes take
/// effect after a rebuild (the string is compiled in via `include_str!`).
pub const GLOBAL_SYSTEM_PROMPT: &str = include_str!("global-system-prompt.md");

/// Compose the final `--append-system-prompt` value for a fresh agent
/// session. Layers from outermost to innermost: bundled global prompt →
/// (optional) Claude-Code MCP rules → MCP nudge → per-repo instructions.
/// Each layer is dropped when empty or whitespace-only. Returns `None`
/// when no layer contributes content, so the caller can skip the CLI
/// flag entirely rather than pass an empty string.
///
/// `claude_code_rules` should be `Some(CLAUDE_CODE_MCP_RULES)` for Claude
/// CLI runs and `None` for harnesses that don't expose those MCP tools
/// (Pi SDK, Codex app-server) — telling a qwen / GPT model to call
/// `AskUserQuestion` or `ExitPlanMode` instructs it to use tools that
/// aren't actually registered with its runtime.
///
/// Resume turns reuse the persistent CLI process and never re-pass
/// `--append-system-prompt`, so this composition only matters on fresh
/// spawns.
pub fn compose_system_prompt(
    repo_instructions: Option<&str>,
    nudge: Option<&str>,
    claude_code_rules: Option<&str>,
) -> Option<String> {
    compose_with_global(
        GLOBAL_SYSTEM_PROMPT,
        repo_instructions,
        nudge,
        claude_code_rules,
    )
}

fn compose_with_global(
    global: &str,
    repo_instructions: Option<&str>,
    nudge: Option<&str>,
    claude_code_rules: Option<&str>,
) -> Option<String> {
    let mut parts: Vec<&str> = Vec::with_capacity(4);
    if !global.trim().is_empty() {
        parts.push(global);
    }
    if let Some(rules) = claude_code_rules
        && !rules.trim().is_empty()
    {
        parts.push(rules);
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
        assert_eq!(compose_with_global("", None, None, None), None);
    }

    #[test]
    fn whitespace_only_layers_treated_as_empty() {
        assert_eq!(
            compose_with_global("  \n\t  ", Some("\n\n"), Some("   "), Some("\t")),
            None
        );
    }

    #[test]
    fn global_only() {
        assert_eq!(
            compose_with_global("GLOBAL", None, None, None),
            Some("GLOBAL".to_string())
        );
    }

    #[test]
    fn nudge_only() {
        assert_eq!(
            compose_with_global("", None, Some("NUDGE"), None),
            Some("NUDGE".to_string())
        );
    }

    #[test]
    fn repo_only() {
        assert_eq!(
            compose_with_global("", Some("REPO"), None, None),
            Some("REPO".to_string())
        );
    }

    #[test]
    fn all_layers_in_priority_order() {
        assert_eq!(
            compose_with_global("GLOBAL", Some("REPO"), Some("NUDGE"), Some("RULES")),
            Some("GLOBAL\n\nRULES\n\nNUDGE\n\nREPO".to_string())
        );
    }

    #[test]
    fn global_and_repo_no_nudge() {
        assert_eq!(
            compose_with_global("GLOBAL", Some("REPO"), None, None),
            Some("GLOBAL\n\nREPO".to_string())
        );
    }

    #[test]
    fn nudge_and_repo_no_global() {
        assert_eq!(
            compose_with_global("", Some("REPO"), Some("NUDGE"), None),
            Some("NUDGE\n\nREPO".to_string())
        );
    }

    #[test]
    fn rules_block_inserted_between_global_and_nudge() {
        // The Claude-Code rules block needs to sit right after the global
        // preamble (so it reads as part of the framing) but before the
        // MCP nudge (which is tool-specific guidance) and before any
        // per-repo instructions (which trump global defaults). This test
        // pins the ordering against accidental reshuffles.
        assert_eq!(
            compose_with_global("GLOBAL", Some("REPO"), Some("NUDGE"), Some("RULES")),
            Some("GLOBAL\n\nRULES\n\nNUDGE\n\nREPO".to_string())
        );
    }

    #[test]
    fn pi_path_excludes_claude_code_rules() {
        // Pi callers pass `None` for `claude_code_rules` because Pi
        // doesn't expose AskUserQuestion / ExitPlanMode — instructing a
        // qwen / llama model to call those tools would point at nothing
        // and confuse the model's identity / capability self-model.
        let composed = compose_system_prompt(Some("REPO"), None, None).unwrap();
        assert!(!composed.contains("AskUserQuestion"));
        assert!(!composed.contains("ExitPlanMode"));
        assert!(composed.contains("REPO"));
    }

    #[test]
    fn claude_cli_path_includes_claude_code_rules() {
        let rules = crate::agent_mcp::CLAUDE_CODE_MCP_RULES;
        let composed = compose_system_prompt(Some("REPO"), None, Some(rules)).unwrap();
        assert!(composed.contains("AskUserQuestion"));
        assert!(composed.contains("ExitPlanMode"));
    }

    #[test]
    fn global_prompt_no_longer_claims_claude_identity() {
        // The shared preamble must not pin the agent's identity to
        // Claude Code, since the same string is broadcast into Pi
        // sessions running local models (qwen, llama, …) where the
        // claim would be inaccurate.
        assert!(
            !GLOBAL_SYSTEM_PROMPT.contains("Claude Code agents"),
            "global preamble should be harness-agnostic"
        );
    }

    #[test]
    fn public_api_uses_bundled_constant() {
        // Concrete content is intentionally not asserted to keep this test
        // stable across edits to `global-system-prompt.md`.
        let composed = compose_system_prompt(Some("REPO"), None, None).unwrap();
        assert!(composed.contains("REPO"));
        assert!(composed.starts_with(GLOBAL_SYSTEM_PROMPT.trim_end()));
    }
}
