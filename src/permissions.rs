// AskUserQuestion and ExitPlanMode are the mechanism the agent uses to talk
// to the user — they are always legitimate regardless of permission level.
// They are ALSO gated by the CLI's own `requiresUserInteraction` step (which
// runs before --allowedTools), so their round-trip is driven through the
// `--permission-prompt-tool stdio` control-request protocol. Listing them
// here is a correctness policy statement and a guard against future CLI
// changes that might drop the requiresUserInteraction short-circuit.
const TOOLS_STANDARD: &[&str] = &[
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

/// Built-in tools that change the machine or the worktree. A restricted
/// level must route every call of these it doesn't pre-approve through
/// Claudette's permission handler (which denies with the escalation path).
///
/// `--allowedTools` alone can't guarantee that: the Claude CLI merges it
/// with `allow` rules from the user's own settings files, and it runs
/// read-only Bash commands (`ls`, `cat`, `git log`, …) without a prompt in
/// every mode. An `ask` rule wins over both (the CLI checks deny, then ask,
/// then allow), so these become `ask` rules for the spawn.
const GATED_TOOLS: &[&str] = &[
    "Bash",
    "PowerShell",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
];

/// The `permissions.ask` rules a Claude spawn needs so its level can't be
/// widened by the user's saved `allow` rules or the CLI's read-only
/// auto-approval: every [`GATED_TOOLS`] entry the level doesn't pre-approve.
///
/// Empty for "full" (bypass) and for an empty tool list, which no
/// permission level produces.
pub fn ask_rules_for(allowed_tools: &[String]) -> Vec<String> {
    if allowed_tools.is_empty() || is_bypass_tools(allowed_tools) {
        return Vec::new();
    }
    GATED_TOOLS
        .iter()
        .filter(|tool| !allowed_tools.iter().any(|allowed| allowed == *tool))
        .map(|tool| (*tool).to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_gates_every_write_capable_tool() {
        let ask = ask_rules_for(&tools_for_level("readonly"));
        for tool in GATED_TOOLS {
            assert!(ask.contains(&(*tool).to_string()), "{tool} not gated");
        }
    }

    #[test]
    fn standard_gates_shell_but_not_its_own_edit_tools() {
        let ask = ask_rules_for(&tools_for_level("standard"));
        assert!(ask.contains(&"Bash".to_string()));
        assert!(ask.contains(&"PowerShell".to_string()));
        assert!(ask.contains(&"NotebookEdit".to_string()));
        // An ask rule beats allow, so gating a pre-approved tool would
        // make standard prompt (and be denied) for its own Write/Edit.
        assert!(!ask.contains(&"Write".to_string()));
        assert!(!ask.contains(&"Edit".to_string()));
    }

    #[test]
    fn full_and_empty_add_no_ask_rules() {
        assert!(ask_rules_for(&tools_for_level("full")).is_empty());
        assert!(ask_rules_for(&[]).is_empty());
    }

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
