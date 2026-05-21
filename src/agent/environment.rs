use std::ffi::{OsStr, OsString};
use std::path::Path;

use tokio::process::Command;

use crate::env_provider::ResolvedEnv;

const CLAUDE_CODE_TEAMMATE_COMMAND: &str = "CLAUDE_CODE_TEAMMATE_COMMAND";

/// Point Claude Code agent-team teammate launches back at the current
/// Claudette executable. Claude Code invokes this command with its teammate
/// identity flags (`--agent-id`, `--agent-name`, `--team-name`); the Tauri
/// binary recognizes that argv shape and redirects the teammate into a
/// Claudette workspace/session instead of spawning another Claude Code process.
pub(crate) fn apply_teammate_command_override(cmd: &mut Command, enabled: bool) {
    if enabled && let Ok(exe) = std::env::current_exe() {
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

pub(crate) struct AgentCommand {
    pub command: Command,
    pub invocation_program: OsString,
    pub invocation_args: Vec<String>,
}

/// Build the process used for an agent harness.
///
/// For regular env-provider output we apply the merged provider map
/// directly. For `env-nix-devshell`, however, the command itself must be
/// started by `nix develop --command …`, matching the integrated
/// terminal's process model. That keeps Nix devshell agents independent
/// from `env-direnv` and avoids importing the user's shell/profile
/// environment into the agent process.
pub(crate) fn build_agent_command(
    program: &OsStr,
    args: &[String],
    working_dir: &Path,
    resolved_env: Option<&ResolvedEnv>,
) -> AgentCommand {
    let wrapped_argv = resolved_env.and_then(|env| {
        crate::env_provider::nix_develop_command_wrap(working_dir, env, program, args)
    });

    let (mut command, invocation_program, invocation_args, wrapped_in_nix_develop) =
        match wrapped_argv {
            Some(argv) => {
                let mut cmd = crate::process::command(&argv[0]);
                cmd.args(&argv[1..]);
                let invocation_program = argv[0].clone();
                let invocation_args = argv[1..]
                    .iter()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect();
                (cmd, invocation_program, invocation_args, true)
            }
            None => {
                let mut cmd = crate::process::command(program);
                cmd.args(args);
                (cmd, program.to_os_string(), args.to_vec(), false)
            }
        };

    command
        .current_dir(working_dir)
        .env("PATH", crate::env::enriched_path());

    if !wrapped_in_nix_develop && let Some(env) = resolved_env {
        apply_resolved_env_to_command(&mut command, env);
    }

    AgentCommand {
        command,
        invocation_program,
        invocation_args,
    }
}

fn agent_path(provider_path: Option<&Option<String>>) -> OsString {
    // A provider that unsets PATH (`Some(None)`) or emits none at all
    // (`None`) leaves the agent on the app's enriched PATH; an emitted
    // value is merged with that base via the shared helper so the agent
    // and the integrated terminal resolve PATH identically (issue #915).
    match provider_path {
        Some(Some(provider_path)) => crate::env::merge_path_with_enriched(provider_path),
        _ => crate::env::enriched_path(),
    }
}

#[cfg(test)]
mod tests {
    use super::{agent_path, build_agent_command};
    use crate::env_provider::{ResolvedEnv, ResolvedSource};
    use std::ffi::OsStr;
    use std::time::SystemTime;

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

    #[test]
    fn agent_command_does_not_wrap_for_direnv_only() {
        let resolved = ResolvedEnv {
            vars: Default::default(),
            sources: vec![ResolvedSource {
                plugin_name: "env-direnv".to_string(),
                detected: true,
                vars_contributed: 0,
                cached: false,
                evaluated_at: SystemTime::now(),
                error: None,
            }],
        };

        let built = build_agent_command(
            OsStr::new("claude"),
            &["--print".to_string()],
            std::path::Path::new("/tmp"),
            Some(&resolved),
        );

        assert_eq!(built.invocation_program, OsStr::new("claude"));
        assert_eq!(built.invocation_args, ["--print"]);
    }
}
