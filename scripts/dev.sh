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
#   --new                  Run as a fresh user — points CLAUDETTE_HOME,
#                          CLAUDETTE_DATA_DIR, and CLAUDE_CONFIG_DIR at a
#                          per-PID tmp tree so the launch sees no existing
#                          state and nothing it writes leaks back to the
#                          real user (workspaces, settings, plugins, or
#                          Claude auth). Useful for testing first-run UX,
#                          plugin/marketplace flows, and login flows
#                          without touching ~/.claudette/ or ~/.claude/.
#   --clone                Run with an rsync'd snapshot of the user's
#                          existing state — points the same three env
#                          vars at a stable tmp tree pre-populated from
#                          ~/.claudette/, the OS data dir holding
#                          claudette.db, and ~/.claude/. Excludes caches
#                          and build artifacts (node_modules, target,
#                          plugins/cache, image-cache, paste-cache,
#                          logs, updates). The sandbox is NOT removed
#                          on exit, so a follow-up `dev --clone` re-
#                          syncs incrementally (rsync delta) — fast.
#                          claudette.db ships as a raw rsync; quit the
#                          release app first if you need a guaranteed
#                          consistent DB snapshot. Mutually exclusive
#                          with --new.
#   --clean                Top-level NUKE action: blasts everything under
#                          ${TMPDIR:-/tmp}/claudette-dev/ (per-PID
#                          sandboxes and discovery files) and exits
#                          without launching. Use when previous --new /
#                          --clone runs were killed with SIGKILL and
#                          left stale sandboxes behind. No PID check —
#                          if you have a dev session running, its
#                          sandbox is removed too; the dev app will
#                          start seeing missing files mid-session.
set -euo pipefail

print_usage() {
  cat <<EOF
Usage: scripts/dev.sh [FLAGS] [-- TAURI_PASSTHROUGH_ARGS...]

Launch the Claudette Tauri dev build with port discovery, sidecar staging,
and (on macOS) the signed-bundle runner so TCC permissions attach to
Claudette rather than the terminal.

Flags:
  --new                Run as a fresh user — points three env vars at a
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
  --clone              Run with an rsync'd snapshot of the user's
                       existing state. The sandbox at
                       \${TMPDIR:-/tmp}/claudette-dev/clone/ is stable
                       (not per-PID) and is NOT removed on exit, so
                       a follow-up \`dev --clone\` re-syncs incrementally
                       — rsync only re-copies what changed in the real
                       source dirs. Caches and build artifacts
                       (node_modules, target, plugin/image/paste caches,
                       logs, updates) are excluded at copy time.
                       claudette.db is rsync'd raw — quit the release
                       app first if you need a guaranteed consistent
                       snapshot. Mutually exclusive with --new. Use
                       \`dev --clean\` to remove the clone sandbox.

                       Gotcha: cloned workspaces' .git pointers still
                       reference the real repo's worktree admin dir, so
                       dev-app writes that touch git state in those
                       workspaces will hit the real repo. Reads are safe.
  --clean              Top-level NUKE action — does not launch the app.
                       Wipes everything under \${TMPDIR:-/tmp}/claudette-dev/
                       (per-PID sandboxes and discovery files) without
                       checking PIDs. If you have a dev session running,
                       its sandbox is removed too — the dev app will
                       start seeing missing files mid-session. Use to
                       reset state after SIGKILL'd runs left a mess.
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

# Stash the full original arg vector before parsing so the mise self-bootstrap
# re-exec below can forward every flag (including --new / --clone / --clean,
# which the parser consumes into local variables and would otherwise drop
# when `$@` is rewritten to passthrough-only just below).
original_args=("$@")

new_session=0
clone_session=0
clean_action=0
passthrough_args=()
while (( $# )); do
  case "$1" in
    --new) new_session=1 ;;
    --clone) clone_session=1 ;;
    --clean) clean_action=1 ;;
    -h|--help) print_usage; exit 0 ;;
    --) shift; passthrough_args+=("$@"); break ;;
    *) passthrough_args+=("$1") ;;
  esac
  shift
done
set -- "${passthrough_args[@]+"${passthrough_args[@]}"}"

if (( new_session && clone_session )); then
  echo "[dev.sh] --new and --clone are mutually exclusive" >&2
  exit 2
fi
if (( clean_action && (new_session || clone_session) )); then
  echo "[dev.sh] --clean is a standalone nuke action — don't combine it with --new or --clone" >&2
  exit 2
fi

# --clean: nuke everything under the discovery dir. No PID checks — if
# there are running dev sessions, their sandboxes go with the sweep
# (the user asked for nuke, that's nuke). Runs before any other setup
# so `dev --clean` works from any directory, even outside the repo.
if (( clean_action )); then
  discovery_dir="${TMPDIR:-/tmp}/claudette-dev"
  if [[ ! -d "$discovery_dir" ]]; then
    echo "[dev.sh] no claudette-dev state at $discovery_dir — nothing to clean"
    exit 0
  fi
  echo "▸ Nuking $discovery_dir"
  removed=0
  for entry in "$discovery_dir"/* "$discovery_dir"/.[!.]* "$discovery_dir"/..?*; do
    [[ -e "$entry" ]] || continue
    echo "  removed: $(basename "$entry")"
    rm -rf "$entry"
    removed=$((removed + 1))
  done
  rmdir "$discovery_dir" 2>/dev/null || true
  echo "[dev.sh] nuked $removed entries under $discovery_dir"
  exit 0
fi

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
    # Use original_args (snapshotted before the parser collapsed $@ to
    # passthrough-only), so flags like --new / --clone / --clean survive
    # the re-exec instead of getting silently dropped.
    exec mise exec -- "$0" "${original_args[@]+"${original_args[@]}"}"
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

sandbox_root=""

if (( new_session )); then
  # Per-PID sandbox so a parallel `dev --new` doesn't reuse this session's
  # state. The cleanup trap removes the directory on exit, but it lives
  # under TMPDIR anyway so a forgotten kill -9 won't leak forever (and
  # `dev --clean` will nuke it later).
  #
  # Three env vars get pointed at the sandbox — only the first two are
  # Claudette-specific. CLAUDE_CONFIG_DIR routes the *Claude CLI's*
  # ~/.claude/ tree, which Claudette actively reads and writes
  # (settings.json, .credentials.json, plugins/, plugins/marketplaces/).
  # Without that override, a --new run that touches plugins, auth, or
  # marketplaces silently writes those changes into the user's real
  # ~/.claude/, defeating the "simulate a new user" purpose of the flag.
  sandbox_root="$discovery_dir/new-$$"
  export CLAUDETTE_HOME="$sandbox_root/home"
  export CLAUDETTE_DATA_DIR="$sandbox_root/data"
  export CLAUDE_CONFIG_DIR="$sandbox_root/claude-config"
  mkdir -p "$CLAUDETTE_HOME" "$CLAUDETTE_DATA_DIR" "$CLAUDE_CONFIG_DIR"
  echo "▸ Fresh-user session: $sandbox_root"
  echo "▸ CLAUDETTE_HOME:     $CLAUDETTE_HOME"
  echo "▸ CLAUDETTE_DATA_DIR: $CLAUDETTE_DATA_DIR"
  echo "▸ CLAUDE_CONFIG_DIR:  $CLAUDE_CONFIG_DIR"
fi

if (( clone_session )); then
  # Stable-path rsync snapshot of the user's real state. Unlike --new,
  # the sandbox dir is NOT per-PID and is NOT removed on exit, so
  # re-running `dev --clone` syncs incrementally — rsync only re-copies
  # what changed. Trade-offs vs the older clonefile-cp approach:
  #
  #   * Simpler: one rsync invocation per root with declarative
  #     --exclude patterns, no post-copy prune step, no sqlite3 backup.
  #   * Re-runnable: a second `dev --clone` is fast (rsync delta).
  #   * Cost: rsync doesn't use APFS clonefile, so the first run copies
  #     full bytes (not block-shared). For one-shot use, the old
  #     clonefile path was cheaper; for iterative dev, rsync wins.
  #
  # claudette.db ships as a raw rsync (no sqlite3 .backup) — that means
  # if the release app is actively writing the DB during clone, the dev
  # copy can be torn. Quit release first if you need a guaranteed
  # consistent snapshot. Most desktops are idle enough that this is fine.
  #
  # Capture source paths BEFORE we overwrite the env vars with sandbox
  # destinations. Mirrors path-resolution in src/path.rs and src/logging.rs.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    default_data_dir="$HOME/Library/Application Support/claudette"
  else
    default_data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/claudette"
  fi
  src_claudette_home="${CLAUDETTE_HOME:-$HOME/.claudette}"
  src_data_dir="${CLAUDETTE_DATA_DIR:-$default_data_dir}"
  src_claude_config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

  sandbox_root="$discovery_dir/clone"
  export CLAUDETTE_HOME="$sandbox_root/home"
  export CLAUDETTE_DATA_DIR="$sandbox_root/data"
  export CLAUDE_CONFIG_DIR="$sandbox_root/claude-config"
  mkdir -p "$sandbox_root"

  if ! command -v rsync >/dev/null 2>&1; then
    echo "[dev.sh] rsync not found on PATH — required for --clone" >&2
    exit 127
  fi

  # One shared exclude list for all three rsyncs. Skips caches, build
  # artifacts, and per-project logs/updates — rebuild for free, take
  # significant disk, and would slow both first-run and re-sync runs.
  rsync_excludes=(
    --exclude=node_modules
    --exclude=target
    --exclude=.next
    --exclude=dist
    --exclude=build
    --exclude=logs
    --exclude=updates
    --exclude=plugins/cache
    --exclude=image-cache
    --exclude=paste-cache
    --exclude=cache
  )

  echo "▸ Clone session:      $sandbox_root  (rsync; re-runs sync incrementally)"
  echo "▸ Source CLAUDETTE_HOME:     $src_claudette_home"
  echo "▸ Source CLAUDETTE_DATA_DIR: $src_data_dir"
  echo "▸ Source CLAUDE_CONFIG_DIR:  $src_claude_config"

  rsync_clone() {
    local src="$1" dst="$2" label="$3"
    if [[ ! -d "$src" ]]; then
      echo "[dev.sh] skipping clone of $label: $src missing" >&2
      mkdir -p "$dst"
      return 0
    fi
    mkdir -p "$dst"
    # `--delete` keeps dest a true mirror of source on re-sync. Special
    # files (sockets, devices) are skipped by rsync with a one-line
    # "skipping non-regular file" note; permission-denied entries get
    # a stderr warning and rsync continues. Both are non-fatal and we
    # don't want them to abort the launch under `set -e`.
    if ! rsync -a --delete --info=stats1 "${rsync_excludes[@]}" "$src/" "$dst/"; then
      echo "[dev.sh] rsync of $label finished with warnings (special files / unreadable entries skipped — continuing)" >&2
    fi
    return 0
  }

  rsync_clone "$src_claudette_home" "$sandbox_root/home"          "CLAUDETTE_HOME"
  rsync_clone "$src_data_dir"       "$sandbox_root/data"          "CLAUDETTE_DATA_DIR"
  rsync_clone "$src_claude_config"  "$sandbox_root/claude-config" "CLAUDE_CONFIG_DIR"

  echo "▸ CLAUDETTE_HOME:     $CLAUDETTE_HOME"
  echo "▸ CLAUDETTE_DATA_DIR: $CLAUDETTE_DATA_DIR"
  echo "▸ CLAUDE_CONFIG_DIR:  $CLAUDE_CONFIG_DIR"
  echo "[dev.sh] Note: cloned workspace .git files still point at the real repo's worktree admin dir; dev-app git writes will land in the real repo." >&2
  echo "[dev.sh] Note: claudette.db was rsync'd raw — quit the release app first if you need a guaranteed-consistent DB snapshot." >&2
fi

cleanup() {
  rm -f "$discovery_file"
  # --new sandboxes are per-PID and ephemeral; remove on exit.
  # --clone sandboxes are intentionally preserved across runs so the
  # next `dev --clone` syncs incrementally instead of doing a cold
  # rsync. Use `dev --clean` to nuke the discovery dir entirely when
  # you actually want the clone gone.
  if (( new_session )) && [[ -n "${sandbox_root:-}" && -d "$sandbox_root" ]]; then
    rm -rf "$sandbox_root"
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
