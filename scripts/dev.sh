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
#   CARGO_TAURI_FEATURES   features to pass to tauri (default devtools,server,voice,alternative-backends)
set -euo pipefail

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

cleanup() { rm -f "$discovery_file"; }
trap cleanup EXIT INT TERM

echo "▸ Branch:           $branch"
echo "▸ Vite dev server:  http://localhost:$vite_port"
echo "▸ Debug eval port:  $debug_port"
echo "▸ Discovery file:   $discovery_file"

"$repo_root/scripts/stage-cli-sidecar.sh" --profile debug

(cd src/ui && bun install)

features="${CARGO_TAURI_FEATURES:-devtools,server,voice,alternative-backends}"
runner_args=()
if [[ "$(uname -s)" == "Darwin" ]]; then
  runner_args=(--runner "$repo_root/scripts/macos-dev-app-runner.sh")
fi

exec "${tauri_cmd[@]}" dev --features "$features" \
  "${runner_args[@]}" \
  -c "{\"build\":{\"devUrl\":\"http://localhost:$vite_port\"}}"
