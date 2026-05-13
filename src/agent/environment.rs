use std::ffi::OsString;

use tokio::process::Command;

use crate::env_provider::ResolvedEnv;

/// Apply workspace provider env to Claude Code without letting provider PATH
/// output break the CLI wrapper itself. Providers keep precedence, but the
/// app's enriched PATH is appended so `/usr/bin/env bash` and other system
/// shims still resolve when a provider emits a narrow PATH.
pub(crate) fn apply_resolved_env_to_command(cmd: &mut Command, env: &ResolvedEnv) {
    env.apply(cmd);
    cmd.env("PATH", agent_path(env.vars.get("PATH")));
}

fn agent_path(provider_path: Option<&Option<String>>) -> OsString {
    let base = crate::env::enriched_path();
    let Some(Some(provider_path)) = provider_path else {
        return base;
    };

    let mut paths = std::env::split_paths(provider_path).collect::<Vec<_>>();
    for path in std::env::split_paths(&base) {
        if !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }

    std::env::join_paths(paths).unwrap_or(base)
}

#[cfg(test)]
mod tests {
    use super::agent_path;

    #[test]
    fn agent_path_appends_base_entries_to_provider_path() {
        let base = crate::env::enriched_path();
        let base_first = std::env::split_paths(&base).next().unwrap();
        let provider = std::env::join_paths(["/custom/bin"]).unwrap();
        let merged = agent_path(Some(&Some(provider.to_string_lossy().to_string())));
        let merged_paths = std::env::split_paths(&merged).collect::<Vec<_>>();

        assert_eq!(
            merged_paths.first().unwrap(),
            &std::path::PathBuf::from("/custom/bin")
        );
        assert!(
            merged_paths.iter().any(|path| path == &base_first),
            "merged PATH must retain enriched base entries; merged={merged:?}, base={base:?}"
        );
    }

    #[test]
    fn agent_path_ignores_provider_path_removal() {
        assert_eq!(agent_path(Some(&None)), crate::env::enriched_path());
    }
}
