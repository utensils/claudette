#!/usr/bin/env bash
# Claudette dev launcher.
#
# Probes for the first free Vite port (starting at 14253 — deliberately NOT
# Tauri's stock 1420, so other Tauri starter-template dev builds can't
# accidentally rebind our port and swap their bundle into our webview) and
# the first free debug eval port (starting at 19432), exports them for the
# child processes, then starts the available Tauri CLI with an inline config
# override so the webview loads from the port Vite actually bound. The mise
# toolchain exposes `tauri`; the Nix devshell exposes `cargo tauri` /
# `cargo-tauri`, so support both launch paths.
#
# A discovery file is written to ${TMPDIR:-/tmp}/claudette-dev/<pid>.json so
# helpers like `debug-eval.sh` can find the matching instance when multiple
# dev builds run side-by-side. The file is cleaned up on exit.
#
# Env overrides:
#   VITE_PORT_BASE         start port for Vite probe (default 14253)
#   CLAUDETTE_DEBUG_PORT_BASE   start port for debug probe (default 19432)
#   CARGO_TAURI_FEATURES   features to pass to tauri (default devtools,server,voice,alternative-backends;
#                          alternative-backends is appended if omitted)
#   CLAUDETTE_DEV_KEEP_CLAUDE_AUTH_ENV
#                         preserve inherited Claude auth env vars (default strips them)
#
# Flags:
#   --clean                Run as a fresh user — points CLAUDETTE_HOME,
#                          CLAUDETTE_DATA_DIR, and CLAUDE_CONFIG_DIR at a
#                          per-PID tmp tree so the launch sees no existing
#                          state and nothing it writes leaks back to the
#                          real user (workspaces, settings, plugins, or
#                          Claude auth). Useful for testing first-run UX,
#                          plugin/marketplace flows, and login flows
#                          without touching ~/.claudette/ or ~/.claude/.
set -euo pipefail

print_usage() {
  cat <<EOF
Usage: scripts/dev.sh [FLAGS] [-- TAURI_PASSTHROUGH_ARGS...]

Launch the Claudette Tauri dev build with port discovery, sidecar staging,
and (on macOS) the signed-bundle runner so TCC permissions attach to
Claudette rather than the terminal.

Flags:
  --clean              Run as a fresh user — points three env vars at a
                       per-PID tmp tree so the launch sees no existing
                       state and nothing it writes leaks back to the
                       real user:

                         CLAUDETTE_HOME      ~/.claudette/ (workspaces,
                                             themes, logs, packs)
                         CLAUDETTE_DATA_DIR  OS data dir for claudette.db
                         CLAUDE_CONFIG_DIR   ~/.claude/ (Claude CLI
                                             settings, credentials,
                                             plugins, marketplaces)

                       Cleaned up on exit. Useful for testing first-run
                       UX (welcome card, onboarding) and plugin/auth
                       flows without nuking real user data.
  -h, --help           Print this usage and exit.
  --                   Pass everything after this flag straight to the
                       Tauri CLI (e.g. --release, --no-default-features).

Env vars (each consulted at process start):
  VITE_PORT_BASE       First Vite port to probe.            Default 14253
  CLAUDETTE_DEBUG_PORT_BASE
                       First debug-eval port to probe.      Default 19432
  CARGO_TAURI_FEATURES Features to forward to \`cargo tauri dev\`.
                       Default: devtools,server,voice,alternative-backends.
                       alternative-backends is always appended when omitted.
  CLAUDETTE_HOME       Override the ~/.claudette/ tree (workspaces,
                       plugins, themes, logs, models, packs, apps.json).
  CLAUDETTE_DATA_DIR   Override the OS data dir holding claudette.db
                       (\`dirs::data_dir()/claudette/\` by default).
  CLAUDE_CONFIG_DIR    Override the Claude CLI's ~/.claude/ tree
                       (settings.json, .credentials.json, plugins,
                       marketplaces). Read by both the Claude CLI
                       itself and Claudette's plugin / auth code paths.
  CLAUDETTE_LOG_DIR    Per-instance log dir override (otherwise derived
                       from CLAUDETTE_HOME).
  CLAUDETTE_DEV_KEEP_CLAUDE_AUTH_ENV
                       Set to 1 to preserve inherited Claude auth env vars
                       such as CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.
                       By default dev launches strip these so Settings and
                       chat exercise the configured Claude Code credentials.

Discovery file:
  Each invocation writes \${TMPDIR:-/tmp}/claudette-dev/<pid>.json so the
  /claudette-debug skill (and similar tools) can find the matching dev
  build when multiple are running. Removed on exit.
EOF
}

clean_session=0
passthrough_args=()
while (( $# )); do
  case "$1" in
    --clean) clean_session=1 ;;
    -h|--help) print_usage; exit 0 ;;
    --) shift; passthrough_args+=("$@"); break ;;
    *) passthrough_args+=("$1") ;;
  esac
  shift
done
set -- "${passthrough_args[@]+"${passthrough_args[@]}"}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

has_tauri_launcher() {
  command -v tauri >/dev/null 2>&1 \
    || cargo tauri --version >/dev/null 2>&1 \
    || command -v cargo-tauri >/dev/null 2>&1
}

# Self-bootstrap mise. `mise exec` only activates the toolchain in mise.toml
# when invoked from a directory that contains it, so `mise exec -- bash
# scripts/dev.sh` from elsewhere silently runs without the npm-installed
# Tauri CLI on PATH. Re-exec under mise once we've cd'd into the repo so the
# script can be invoked plain (`bash scripts/dev.sh`) or via `mise exec`,
# from any cwd, without divergent behaviour. The sentinel guards against
# infinite re-exec when mise lacks the toolchain.
if ! has_tauri_launcher \
   && [[ -z "${CLAUDETTE_DEV_MISE_REEXEC:-}" ]] \
   && command -v mise >/dev/null 2>&1 \
   && [[ -f mise.toml ]]; then
    export CLAUDETTE_DEV_MISE_REEXEC=1
    exec mise exec -- "$0" "$@"
fi

if command -v tauri >/dev/null 2>&1; then
    tauri_cmd=(tauri)
elif cargo tauri --version >/dev/null 2>&1; then
    tauri_cmd=(cargo tauri)
elif command -v cargo-tauri >/dev/null 2>&1; then
    tauri_cmd=(cargo-tauri)
else
    cat >&2 <<'EOF'
[dev.sh] Tauri CLI not found on PATH. Install one of:
  - mise:  install mise (https://mise.jdx.dev), then run `mise install`.
  - Nix:   `nix develop` activates a devshell with cargo-tauri.
  - Cargo: `cargo install tauri-cli --version "^2.0" --locked`
EOF
    exit 127
fi

find_free_port() {
  local p=$1
  while lsof -iTCP:"$p" -sTCP:LISTEN -n -P >/dev/null 2>&1; do
    p=$((p + 1))
  done
  echo "$p"
}

# Default Vite port is 14253 — deliberately moved off Tauri's stock 1420
# to avoid the cross-app dev-port hijack scenario where another Tauri
# starter template (which also defaults to 1420) launches and rebinds
# the port underneath our running webview, displaying its own bundle in
# Claudette's window. The inline guard in src/ui/index.html catches the
# residual case where another app still picks the same number.
vite_port=$(find_free_port "${VITE_PORT_BASE:-14253}")
debug_port=$(find_free_port "${CLAUDETTE_DEBUG_PORT_BASE:-19432}")

export VITE_PORT="$vite_port"
export CLAUDETTE_DEBUG_PORT="$debug_port"

strip_inherited_claude_auth_env() {
  # Codex/Claude-hosted shells can provide ephemeral Claude Code auth through
  # env vars. Dev builds must exercise the user's real Claude Code config, so
  # avoid letting those parent-process credentials mask sign-in bugs.
  if [[ "${CLAUDETTE_DEV_KEEP_CLAUDE_AUTH_ENV:-}" == "1" ]]; then
    return
  fi

  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_AUTH_TOKEN
  unset ANTHROPIC_FOUNDRY_API_KEY
  unset ANTHROPIC_UNIX_SOCKET
  unset AWS_BEARER_TOKEN_BEDROCK
  unset CLAUDE_BRIDGE_OAUTH_TOKEN
  unset CLAUDE_SESSION_INGRESS_TOKEN_FILE
  unset CLAUDE_TRUSTED_DEVICE_TOKEN
  unset CLAUDECODE
  unset CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  unset CLAUDE_CODE_ENTRYPOINT
  unset CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  unset CLAUDE_CODE_OAUTH_SCOPES
  unset CLAUDE_CODE_OAUTH_TOKEN
  unset CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  unset CLAUDE_CODE_SESSION_ACCESS_TOKEN
  unset CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
}

strip_inherited_claude_auth_env

discovery_dir="${TMPDIR:-/tmp}/claudette-dev"
mkdir -p "$discovery_dir"
discovery_file="$discovery_dir/$$.json"

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
cwd="$(pwd)"
started="$(date +%s)"

# Build JSON via python3's json module so paths or branch names containing
# quotes, backslashes, or newlines don't break the discovery file. `python3`
# is already an explicit prerequisite of the debug eval helper, so making
# the devshell depend on it too is consistent.
python3 -c '
import json, sys
out, pid, debug_port, vite_port, started, cwd, branch = sys.argv[1:8]
with open(out, "w") as f:
    json.dump({
        "pid": int(pid),
        "debug_port": int(debug_port),
        "vite_port": int(vite_port),
        "cwd": cwd,
        "branch": branch,
        "started_at": int(started),
    }, f)
' "$discovery_file" "$$" "$debug_port" "$vite_port" "$started" "$cwd" "$branch"

if (( clean_session )); then
  # Per-PID sandbox so a parallel `dev --clean` doesn't reuse this session's
  # state. The cleanup trap removes the directory on exit, but it lives
  # under TMPDIR anyway so a forgotten kill -9 won't leak forever.
  #
  # Three env vars get pointed at the sandbox — only the first two are
  # Claudette-specific. CLAUDE_CONFIG_DIR routes the *Claude CLI's*
  # ~/.claude/ tree, which Claudette actively reads and writes
  # (settings.json, .credentials.json, plugins/, plugins/marketplaces/).
  # Without that override, a --clean run that touches plugins, auth, or
  # marketplaces silently writes those changes into the user's real
  # ~/.claude/, defeating the "simulate a new user" purpose of the flag.
  clean_root="$discovery_dir/clean-$$"
  export CLAUDETTE_HOME="$clean_root/home"
  export CLAUDETTE_DATA_DIR="$clean_root/data"
  export CLAUDE_CONFIG_DIR="$clean_root/claude-config"
  mkdir -p "$CLAUDETTE_HOME" "$CLAUDETTE_DATA_DIR" "$CLAUDE_CONFIG_DIR"
  echo "▸ Clean session:      $clean_root"
  echo "▸ CLAUDETTE_HOME:     $CLAUDETTE_HOME"
  echo "▸ CLAUDETTE_DATA_DIR: $CLAUDETTE_DATA_DIR"
  echo "▸ CLAUDE_CONFIG_DIR:  $CLAUDE_CONFIG_DIR"
fi

cleanup() {
  rm -f "$discovery_file"
  if (( clean_session )) && [[ -n "${clean_root:-}" && -d "$clean_root" ]]; then
    rm -rf "$clean_root"
  fi
}
trap cleanup EXIT INT TERM

echo "▸ Branch:           $branch"
echo "▸ Vite dev server:  http://localhost:$vite_port"
echo "▸ Debug eval port:  $debug_port"
echo "▸ Discovery file:   $discovery_file"

"$repo_root/scripts/stage-cli-sidecar.sh" --profile debug

(cd src/ui && bun install)

features="${CARGO_TAURI_FEATURES:-devtools,server,voice,alternative-backends}"
if [[ ",$features," != *",alternative-backends,"* ]]; then
  features="${features:+$features,}alternative-backends"
fi
runner_args=()
if [[ "$(uname -s)" == "Darwin" ]]; then
  runner_args=(--runner "$repo_root/scripts/macos-dev-app-runner.sh")
fi

exec "${tauri_cmd[@]}" dev --features "$features" \
  "${runner_args[@]}" \
  -c "{\"build\":{\"devUrl\":\"http://localhost:$vite_port\"}}"
