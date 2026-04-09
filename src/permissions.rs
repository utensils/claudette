const TOOLS_STANDARD: &[&str] = &[
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
];

const TOOLS_READONLY: &[&str] = &["Read", "Glob", "Grep", "WebSearch", "WebFetch"];

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
}
