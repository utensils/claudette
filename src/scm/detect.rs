use std::collections::HashMap;

use crate::plugin_runtime::LoadedPlugin;

/// Extract the hostname from a git remote URL.
///
/// Handles both SSH and HTTPS formats:
/// - `git@github.com:user/repo.git` → `github.com`
/// - `https://github.com/user/repo.git` → `github.com`
/// - `ssh://git@gitlab.example.com:2222/user/repo.git` → `gitlab.example.com`
pub fn parse_hostname(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();

    // SSH format: git@host:path or ssh://git@host/path or ssh://git@host:port/path
    if let Some(rest) = url.strip_prefix("ssh://") {
        // ssh://git@host:port/path or ssh://git@host/path
        let after_at = rest.split('@').next_back()?;
        let host = after_at.split('/').next()?;
        // Strip port if present
        let host = host.split(':').next()?;
        return Some(host.to_lowercase());
    }

    if url.contains('@') && url.contains(':') && !url.contains("://") {
        // git@host:user/repo.git
        let after_at = url.split('@').nth(1)?;
        let host = after_at.split(':').next()?;
        return Some(host.to_lowercase());
    }

    // HTTPS format: https://host/path
    if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        let host = rest.split('/').next()?;
        // Strip port if present
        let host = host.split(':').next()?;
        return Some(host.to_lowercase());
    }

    None
}

/// Detect the SCM provider plugin for a given git remote URL.
///
/// Matches the hostname from the remote URL against each plugin's declared
/// `remote_patterns`. Only considers plugins whose CLI is available.
/// If multiple plugins match, prefers the one with the longest matching pattern.
pub fn detect_provider(
    remote_url: &str,
    plugins: &HashMap<String, LoadedPlugin>,
) -> Option<String> {
    let hostname = parse_hostname(remote_url)?;

    let mut best_match: Option<(String, usize)> = None;

    for (name, plugin) in plugins {
        if !plugin.cli_available {
            continue;
        }
        for pattern in &plugin.manifest.remote_patterns {
            if hostname.contains(&pattern.to_lowercase())
                && best_match
                    .as_ref()
                    .is_none_or(|(_, len)| pattern.len() > *len)
            {
                best_match = Some((name.clone(), pattern.len()));
            }
        }
    }

    best_match.map(|(name, _)| name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hostname_https() {
        assert_eq!(
            parse_hostname("https://github.com/user/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn test_parse_hostname_ssh() {
        assert_eq!(
            parse_hostname("git@github.com:user/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn test_parse_hostname_ssh_protocol() {
        assert_eq!(
            parse_hostname("ssh://git@gitlab.example.com:2222/user/repo.git"),
            Some("gitlab.example.com".to_string())
        );
    }

    #[test]
    fn test_parse_hostname_http() {
        assert_eq!(
            parse_hostname("http://gitea.local/user/repo.git"),
            Some("gitea.local".to_string())
        );
    }

    #[test]
    fn test_parse_hostname_case_insensitive() {
        assert_eq!(
            parse_hostname("https://GitHub.COM/user/repo"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn test_parse_hostname_invalid() {
        assert_eq!(parse_hostname("not-a-url"), None);
    }

    #[test]
    fn test_detect_provider_github() {
        let mut plugins = HashMap::new();
        plugins.insert(
            "github".to_string(),
            make_plugin("github", &["github.com"], true),
        );
        plugins.insert(
            "gitlab".to_string(),
            make_plugin("gitlab", &["gitlab.com"], true),
        );

        assert_eq!(
            detect_provider("git@github.com:user/repo.git", &plugins),
            Some("github".to_string())
        );
    }

    #[test]
    fn test_detect_provider_gitlab() {
        let mut plugins = HashMap::new();
        plugins.insert(
            "github".to_string(),
            make_plugin("github", &["github.com"], true),
        );
        plugins.insert(
            "gitlab".to_string(),
            make_plugin("gitlab", &["gitlab.com"], true),
        );

        assert_eq!(
            detect_provider("https://gitlab.com/user/repo.git", &plugins),
            Some("gitlab".to_string())
        );
    }

    #[test]
    fn test_detect_provider_self_hosted_gitlab() {
        let mut plugins = HashMap::new();
        plugins.insert(
            "gitlab".to_string(),
            make_plugin("gitlab", &["gitlab."], true),
        );

        assert_eq!(
            detect_provider("https://gitlab.mycorp.com/group/repo.git", &plugins),
            Some("gitlab".to_string())
        );
    }

    #[test]
    fn test_detect_provider_cli_unavailable() {
        let mut plugins = HashMap::new();
        plugins.insert(
            "github".to_string(),
            make_plugin("github", &["github.com"], false),
        );

        assert_eq!(
            detect_provider("https://github.com/user/repo.git", &plugins),
            None
        );
    }

    #[test]
    fn test_detect_provider_no_match() {
        let mut plugins = HashMap::new();
        plugins.insert(
            "github".to_string(),
            make_plugin("github", &["github.com"], true),
        );

        assert_eq!(
            detect_provider("https://bitbucket.org/user/repo.git", &plugins),
            None
        );
    }

    #[test]
    fn test_detect_provider_prefers_longest_pattern() {
        let mut plugins = HashMap::new();
        // A generic "github." matcher and a specific "github.com" matcher
        plugins.insert(
            "github-generic".to_string(),
            make_plugin("github-generic", &["github."], true),
        );
        plugins.insert(
            "github-specific".to_string(),
            make_plugin("github-specific", &["github.com"], true),
        );

        assert_eq!(
            detect_provider("https://github.com/user/repo.git", &plugins),
            Some("github-specific".to_string())
        );
    }

    fn make_plugin(name: &str, patterns: &[&str], cli_available: bool) -> LoadedPlugin {
        use crate::plugin_runtime::manifest::PluginManifest;
        LoadedPlugin {
            manifest: PluginManifest {
                name: name.to_string(),
                display_name: name.to_string(),
                version: "1.0.0".to_string(),
                description: "test".to_string(),
                required_clis: vec![],
                remote_patterns: patterns.iter().map(|s| s.to_string()).collect(),
                operations: vec![],
                config_schema: std::collections::HashMap::new(),
                kind: crate::plugin_runtime::manifest::PluginKind::Scm,
                settings: vec![],
                languages: vec![],
                grammars: vec![],
            },
            dir: std::path::PathBuf::new(),
            config: std::collections::HashMap::new(),
            cli_available,
            trust: crate::plugin_runtime::PluginTrust::Unknown,
        }
    }
}
