// AskUserQuestion and ExitPlanMode are the mechanism the agent uses to talk
// to the user — they are always legitimate regardless of permission level.
// They are ALSO gated by the CLI's own `requiresUserInteraction` step (which
// runs before --allowedTools), so their round-trip is driven through the
// `--permission-prompt-tool stdio` control-request protocol. Listing them
// here is a correctness policy statement and a guard against future CLI
// changes that might drop the requiresUserInteraction short-circuit.
const TOOLS_STANDARD: &[&str] = &[
    "Agent",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "AskUserQuestion",
    "ExitPlanMode",
];

const TOOLS_READONLY: &[&str] = &[
    "Agent",
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "AskUserQuestion",
    "ExitPlanMode",
];

/// Map a permission level name to the tools to pre-approve.
/// "full" returns the wildcard sentinel `["*"]`, which `build_claude_args`
/// interprets as `--permission-mode bypassPermissions` (skips all permission
/// checks, including for MCP tools).
pub fn tools_for_level(level: &str) -> Vec<String> {
    let tools: &[&str] = match level {
        "full" => return vec!["*".to_string()],
        "standard" => TOOLS_STANDARD,
        _ => TOOLS_READONLY,
    };
    tools.iter().map(|s| (*s).to_string()).collect()
}

/// Returns true when `tools` is the singleton wildcard sentinel `["*"]` — the
/// shape `tools_for_level("full")` produces and `build_claude_args` /
/// `build_persistent_args` treat as "spawn with `--permission-mode
/// bypassPermissions`". The control-request handler uses this same predicate
/// to decide whether a stray `can_use_tool` should be auto-allowed.
pub fn is_bypass_tools(tools: &[String]) -> bool {
    tools.len() == 1 && tools[0] == "*"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_returns_wildcard() {
        assert_eq!(tools_for_level("full"), vec!["*"]);
    }

    #[test]
    fn standard_excludes_bash() {
        let tools = tools_for_level("standard");
        assert!(tools.contains(&"Read".to_string()));
        assert!(!tools.contains(&"Bash".to_string()));
    }

    #[test]
    fn readonly_is_restrictive() {
        let tools = tools_for_level("readonly");
        assert!(tools.contains(&"Read".to_string()));
        assert!(!tools.contains(&"Write".to_string()));
        assert!(!tools.contains(&"Edit".to_string()));
        assert!(!tools.contains(&"Bash".to_string()));
    }

    #[test]
    fn unknown_level_defaults_to_readonly() {
        assert_eq!(tools_for_level("unknown"), tools_for_level("readonly"));
    }

    #[test]
    fn is_bypass_tools_recognizes_singleton_wildcard() {
        assert!(is_bypass_tools(&["*".to_string()]));
        assert!(!is_bypass_tools(&[]));
        assert!(!is_bypass_tools(&["Read".to_string()]));
        assert!(!is_bypass_tools(&["*".to_string(), "Read".to_string()]));
    }

    #[test]
    fn ask_user_question_is_allowed_at_readonly_and_standard_levels() {
        // `full` returns the wildcard sentinel `["*"]`, so the explicit
        // names only need to be present at the more restricted levels.
        for level in ["readonly", "standard"] {
            let tools = tools_for_level(level);
            assert!(
                tools.contains(&"Agent".to_string()),
                "Agent missing at level {level}"
            );
            assert!(
                tools.contains(&"AskUserQuestion".to_string()),
                "AskUserQuestion missing at level {level}"
            );
            assert!(
                tools.contains(&"ExitPlanMode".to_string()),
                "ExitPlanMode missing at level {level}"
            );
        }
    }
}
