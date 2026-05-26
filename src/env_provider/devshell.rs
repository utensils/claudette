//! Wrapping the integrated terminal in the workspace's own Nix devshell.
//!
//! When a workspace has a Nix flake (or legacy `shell.nix`) and the
//! `env-nix-devshell` provider is enabled, the integrated terminal is
//! spawned as plain `nix develop` so it lands inside *that workspace's*
//! devshell — rather than inheriting whichever devshell the Claudette
//! process itself happens to be running in. See issue #915.
//!
//! Crucially the terminal runs `nix develop` with **no `--command`**, so
//! it drops into the devshell's *own* shell (the flake's `shellHook`
//! runs, the toolchain is on `PATH`). It deliberately does NOT launch the
//! user's personal interactive shell inside the devshell: doing that
//! re-runs the user's full shell profile (oh-my-zsh, `nix-daemon.sh`, and
//! on nix-darwin the `/etc/zshenv` `set-environment` reset), which
//! hard-overwrites `PATH` and strips the devshell back out — the devshell
//! would "enter, then vanish".
//!
//! `env-nix-devshell` and `env-direnv` are totally separate plugins with
//! separate jobs. This wrap enters the devshell via `nix develop`
//! directly — it never routes through direnv, and the wrap decision
//! never consults direnv (or any other provider's) resolve result.

use std::ffi::{OsStr, OsString};
use std::path::Path;

use super::ResolvedEnv;

/// Bundled Nix devshell env-provider plugin name.
const NIX_DEVSHELL_PLUGIN: &str = "env-nix-devshell";

/// Build the `nix develop` argv that opens the integrated terminal inside
/// the workspace's devshell, or `None` to spawn a plain shell instead
/// (the fallback).
///
/// The wrap fires whenever the `env-nix-devshell` provider *applies* to
/// the workspace — the provider is enabled, `nix` is on PATH, and a
/// `flake.nix` / `shell.nix` is present. `None` is returned only when
/// there is genuinely nothing to enter: the provider is disabled, `nix`
/// is not installed, or the workspace has no flake.
///
/// It is intentionally NOT gated on the provider's env-var probe
/// (`nix print-dev-env`) succeeding. The probe and `nix develop` are
/// separate operations: a probe timeout or eval hiccup must never
/// silently drop the terminal into a plain shell with the wrong
/// toolchain. If the flake is genuinely broken, `nix develop` surfaces
/// the error *in the terminal* — visible, not hidden behind a fallback.
///
/// The returned vec is the complete `nix develop` argv
/// (`[<nix>, "develop", ("-f" <shell.nix>)?]`) — spawn it as-is. There is
/// deliberately no `--command`: `nix develop` then drops the terminal
/// into the devshell's own shell (see the module docs for why launching
/// the user's personal shell would defeat the wrap).
pub fn nix_develop_wrap(worktree: &Path, resolved: &ResolvedEnv) -> Option<Vec<String>> {
    if !devshell_detected(resolved) {
        return None;
    }
    let nix = crate::env::which_in_enriched_path("nix").ok()?;
    Some(build_wrap_argv(&nix, worktree))
}

/// Build a `nix develop --command <program> <args...>` argv for
/// non-interactive workspace subprocesses, or `None` when the workspace
/// should run the command directly.
///
/// This is the agent-side counterpart to [`nix_develop_wrap`]. Agents
/// are not interactive terminals, so they need an explicit command to
/// run inside the devshell. Crucially, callers should spawn the returned
/// argv as-is and avoid applying the merged env-provider map on top: a
/// `flake.nix` workspace's Nix devshell is its own activation path and
/// must not be contaminated by `env-direnv` output from an `.envrc`.
pub fn nix_develop_command_wrap(
    worktree: &Path,
    resolved: &ResolvedEnv,
    program: &OsStr,
    args: &[String],
) -> Option<Vec<OsString>> {
    if !devshell_detected(resolved) {
        return None;
    }
    let nix = crate::env::which_in_enriched_path("nix").ok()?;
    Some(build_command_wrap_argv(&nix, worktree, program, args))
}

/// Did the `env-nix-devshell` provider detect a devshell for this
/// workspace?
///
/// `detected` is the provider's own verdict and already encodes every
/// precondition for `nix develop` to apply: it is `true` only when the
/// provider is enabled (a disabled provider records `detected = false`),
/// `nix` is available (an unavailable one records `detected = false`),
/// and a `flake.nix` / `shell.nix` exists on disk. Crucially it stays
/// `true` even when the provider's *export* errored — so a flaky
/// `nix print-dev-env` probe never suppresses the wrap. Only the
/// `env-nix-devshell` source is consulted; other providers (notably
/// `env-direnv`) never influence this decision.
fn devshell_detected(resolved: &ResolvedEnv) -> bool {
    resolved
        .sources
        .iter()
        .any(|source| source.plugin_name == NIX_DEVSHELL_PLUGIN && source.detected)
}

/// Assemble the `nix develop` argv. A `flake.nix` is auto-discovered from
/// the spawn cwd; a legacy `shell.nix`-only repo needs an explicit `-f`
/// (mirrors the `installable_args` the env-nix-devshell plugin uses for
/// its own `print-dev-env` call).
fn build_wrap_argv(nix: &Path, worktree: &Path) -> Vec<String> {
    let mut argv = vec![nix.to_string_lossy().into_owned(), "develop".to_string()];
    if !worktree.join("flake.nix").exists() {
        let shell_nix = worktree.join("shell.nix");
        if shell_nix.exists() {
            argv.push("-f".to_string());
            argv.push(shell_nix.to_string_lossy().into_owned());
        }
    }
    argv
}

fn build_command_wrap_argv(
    nix: &Path,
    worktree: &Path,
    program: &OsStr,
    args: &[String],
) -> Vec<OsString> {
    let mut argv = build_wrap_argv(nix, worktree)
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    argv.push(OsString::from("--command"));
    argv.push(program.to_os_string());
    argv.extend(args.iter().map(OsString::from));
    argv
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env_provider::ResolvedSource;
    use std::time::SystemTime;

    fn source(name: &str, detected: bool, error: Option<&str>) -> ResolvedSource {
        ResolvedSource {
            plugin_name: name.to_string(),
            detected,
            vars_contributed: 0,
            cached: false,
            evaluated_at: SystemTime::now(),
            error: error.map(str::to_string),
        }
    }

    fn resolved(sources: Vec<ResolvedSource>) -> ResolvedEnv {
        ResolvedEnv {
            vars: Default::default(),
            sources,
        }
    }

    #[test]
    fn wraps_when_devshell_detected() {
        assert!(devshell_detected(&resolved(vec![source(
            "env-nix-devshell",
            true,
            None
        )])));
    }

    #[test]
    fn wraps_even_when_export_probe_failed() {
        // ZERO EXCEPTIONS: a flake whose `nix print-dev-env` probe
        // errored is still detected, so the terminal must still wrap in
        // `nix develop`. The probe and `nix develop` are separate
        // operations — a flaky probe must never demote the terminal to
        // a plain shell with the wrong toolchain. If the flake really
        // is broken, `nix develop` shows the error in the terminal.
        assert!(devshell_detected(&resolved(vec![source(
            "env-nix-devshell",
            true,
            Some("export: error: flake.nix is broken"),
        )])));
    }

    #[test]
    fn not_detected_when_provider_disabled() {
        // A disabled provider records `detected = false` (with an
        // `error: "disabled"` marker) — the user opted out, so no wrap.
        assert!(!devshell_detected(&resolved(vec![source(
            "env-nix-devshell",
            false,
            Some("disabled"),
        )])));
    }

    #[test]
    fn not_detected_when_no_flake() {
        // No `flake.nix` / `shell.nix` on disk — nothing to enter.
        assert!(!devshell_detected(&resolved(vec![source(
            "env-nix-devshell",
            false,
            None
        )])));
    }

    #[test]
    fn not_detected_when_only_other_providers() {
        // env-nix-devshell and env-direnv are totally separate plugins:
        // a direnv hit must never make the terminal `nix develop`.
        assert!(!devshell_detected(&resolved(vec![source(
            "env-direnv",
            true,
            None
        )])));
    }

    #[test]
    fn wrap_argv_auto_discovers_flake() {
        // `flake.nix` present: bare `nix develop`, no `-f`, no
        // `--command` — `nix develop` opens the devshell's own shell.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("flake.nix"), "{}").unwrap();
        assert_eq!(
            build_wrap_argv(Path::new("/usr/bin/nix"), tmp.path()),
            vec!["/usr/bin/nix", "develop"],
        );
    }

    #[test]
    fn wrap_argv_passes_shell_nix_explicitly() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("shell.nix"), "{}").unwrap();
        let shell_nix = tmp.path().join("shell.nix").to_string_lossy().into_owned();
        assert_eq!(
            build_wrap_argv(Path::new("/usr/bin/nix"), tmp.path()),
            vec!["/usr/bin/nix", "develop", "-f", shell_nix.as_str()],
        );
    }

    #[test]
    fn wrap_argv_prefers_flake_over_shell_nix() {
        // `nix print-dev-env` auto-discovers only flake.nix, so when both
        // exist the wrap must not pass `-f shell.nix` — the two paths
        // would otherwise target different devshells.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("flake.nix"), "{}").unwrap();
        std::fs::write(tmp.path().join("shell.nix"), "{}").unwrap();
        assert_eq!(
            build_wrap_argv(Path::new("/usr/bin/nix"), tmp.path()),
            ["/usr/bin/nix", "develop"].map(String::from),
        );
    }

    #[test]
    fn command_wrap_argv_runs_program_inside_flake_devshell() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("flake.nix"), "{}").unwrap();
        assert_eq!(
            build_command_wrap_argv(
                Path::new("/usr/bin/nix"),
                tmp.path(),
                OsStr::new("/opt/bin/claude"),
                &["--print".to_string(), "hello".to_string()],
            ),
            vec![
                OsString::from("/usr/bin/nix"),
                OsString::from("develop"),
                OsString::from("--command"),
                OsString::from("/opt/bin/claude"),
                OsString::from("--print"),
                OsString::from("hello"),
            ],
        );
    }

    #[test]
    fn command_wrap_argv_keeps_shell_nix_before_command() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("shell.nix"), "{}").unwrap();
        let shell_nix = tmp.path().join("shell.nix");
        assert_eq!(
            build_command_wrap_argv(
                Path::new("/usr/bin/nix"),
                tmp.path(),
                OsStr::new("codex"),
                &["app-server".to_string()],
            ),
            vec![
                OsString::from("/usr/bin/nix"),
                OsString::from("develop"),
                OsString::from("-f"),
                shell_nix.into_os_string(),
                OsString::from("--command"),
                OsString::from("codex"),
                OsString::from("app-server"),
            ],
        );
    }
}
