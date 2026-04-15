use claudette::permissions::tools_for_level;

/// "full" level should return the wildcard sentinel ["*"].
#[test]
fn test_permissions_full_level() {
    let tools = tools_for_level("full");
    assert_eq!(tools, vec!["*"]);
}

/// Unknown level should fall back to readonly tools.
#[test]
fn test_permissions_unknown_level() {
    let tools = tools_for_level("nonexistent_level");
    assert_eq!(tools, tools_for_level("readonly"));
    assert!(!tools.contains(&"Write".to_string()));
    assert!(!tools.contains(&"Edit".to_string()));
}

/// Empty string level falls back to readonly.
#[test]
fn test_permissions_empty_level() {
    let tools = tools_for_level("");
    assert_eq!(tools, tools_for_level("readonly"));
}

/// Level names are case-sensitive. "FULL" is not "full".
#[test]
fn test_permissions_case_sensitivity() {
    let full = tools_for_level("full");
    let upper = tools_for_level("FULL");
    // "FULL" falls through to readonly default, "full" returns wildcard
    assert_ne!(full, upper);
    assert_eq!(full, vec!["*"]);
    assert_eq!(upper, tools_for_level("readonly"));
}

/// "standard" level includes Read but not Bash.
#[test]
fn test_permissions_standard_level() {
    let tools = tools_for_level("standard");
    assert!(tools.contains(&"Read".to_string()));
    assert!(tools.contains(&"Write".to_string()));
    assert!(!tools.contains(&"Bash".to_string()));
}

/// Determinism: same level always returns same tools.
#[test]
fn test_permissions_deterministic() {
    let t1 = tools_for_level("full");
    let t2 = tools_for_level("full");
    assert_eq!(t1, t2);
}
