#!/usr/bin/env bash
# Claudette dev launcher.
#
# Probes for the first free Vite port (starting at 1420) and the first free
# debug eval port (starting at 19432), exports them for the child processes,
# then starts `cargo tauri dev` with an inline config override so the webview
# loads from the port Vite actually bound.
#
# A discovery file is written to ${TMPDIR:-/tmp}/claudette-dev/<pid>.json so
# helpers like `debug-eval.sh` can find the matching instance when multiple
# dev builds run side-by-side. The file is cleaned up on exit.
#
# Env overrides:
#   VITE_PORT_BASE         start port for Vite probe (default 1420)
#   CLAUDETTE_DEBUG_PORT_BASE   start port for debug probe (default 19432)
#   CARGO_TAURI_FEATURES   features to pass to tauri (default devtools,server)
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

find_free_port() {
  local p=$1
  while lsof -iTCP:"$p" -sTCP:LISTEN -n -P >/dev/null 2>&1; do
    p=$((p + 1))
  done
  echo "$p"
}

vite_port=$(find_free_port "${VITE_PORT_BASE:-1420}")
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

(cd src/ui && bun install)

features="${CARGO_TAURI_FEATURES:-devtools,server}"

exec cargo tauri dev --features "$features" \
  -c "{\"build\":{\"devUrl\":\"http://localhost:$vite_port\"}}"
