use std::ffi::OsString;

use tokio::process::Command;

use crate::env_provider::ResolvedEnv;

const CLAUDE_CODE_TEAMMATE_COMMAND: &str = "CLAUDE_CODE_TEAMMATE_COMMAND";

/// Point Claude Code agent-team teammate launches back at the current
/// Claudette executable. Claude Code invokes this command with its teammate
/// identity flags (`--agent-id`, `--agent-name`, `--team-name`); the Tauri
/// binary recognizes that argv shape and redirects the teammate into a
/// Claudette workspace/session instead of spawning another Claude Code process.
pub(crate) fn apply_teammate_command_override(cmd: &mut Command) {
    if let Ok(exe) = std::env::current_exe() {
        cmd.env(CLAUDE_CODE_TEAMMATE_COMMAND, exe);
    }
}

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

    #[test]
    fn teammate_command_env_var_name_matches_claude_code() {
        assert_eq!(
            super::CLAUDE_CODE_TEAMMATE_COMMAND,
            "CLAUDE_CODE_TEAMMATE_COMMAND"
        );
    }
}
