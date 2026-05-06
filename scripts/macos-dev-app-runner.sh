#!/usr/bin/env bash
# cargo-tauri runner for macOS development builds.
#
# TCC enforces speech/microphone permissions through the *responsible*
# process — when cargo-tauri exec's our binary directly, the responsible
# process is the terminal that started cargo-tauri, and TCC checks the
# terminal's Info.plist (not ours) for the privacy keys, then aborts when
# they're missing. To get TCC to attribute the request to Claudette itself
# we (1) wrap the built binary in a real .app bundle, (2) sign that bundle
# with the packaged app's entitlements, and (3) launch via Launch Services
# (`open -W`) so the .app becomes its own responsible process.
if [ -z "${BASH_VERSION:-}" ]; then
  exec /usr/bin/env bash "$0" "$@"
fi

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: macos-dev-app-runner.sh <binary>|run [cargo/app args...]" >&2
  exit 64
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$1" ]; then
  binary="$1"
  shift
  app_args=("$@")
else
  if [ "$1" != "run" ]; then
    echo "unsupported Tauri runner command: $1" >&2
    exit 64
  fi
  shift

  build_args=(build --manifest-path "$repo_root/src-tauri/Cargo.toml")
  app_args=()
  profile=debug
  target_triple=""
  in_app_args=false

  while [ "$#" -gt 0 ]; do
    if [ "$in_app_args" = true ]; then
      app_args+=("$1")
      shift
      continue
    fi

    case "$1" in
      --)
        in_app_args=true
        shift
        ;;
      --release)
        profile=release
        build_args+=("$1")
        shift
        ;;
      --target)
        if [ "$#" -lt 2 ]; then
          echo "missing value for --target" >&2
          exit 64
        fi
        build_args+=("$1" "$2")
        target_triple="$2"
        shift 2
        ;;
      --target=*)
        build_args+=("$1")
        target_triple="${1#--target=}"
        shift
        ;;
      *)
        build_args+=("$1")
        shift
        ;;
    esac
  done

  cargo "${build_args[@]}"

  target_dir="${CARGO_TARGET_DIR:-$repo_root/target}"
  if [[ "$target_dir" != /* ]]; then
    target_dir="$repo_root/$target_dir"
  fi

  if [ -n "$target_triple" ]; then
    binary="$target_dir/$target_triple/$profile/claudette-app"
  else
    binary="$target_dir/$profile/claudette-app"
  fi
fi

if [ ! -f "$binary" ]; then
  echo "built binary not found: $binary" >&2
  exit 66
fi

binary_dir="$(cd "$(dirname "$binary")" && pwd)"
bundle_dir="${CLAUDETTE_DEV_APP_BUNDLE:-$binary_dir/Claudette Dev.app}"
contents_dir="$bundle_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
bundle_executable="$macos_dir/claudette-app"
managed_app_pids=()

launched_app_pids() {
  ps -axo pid=,command= | while read -r pid command; do
    if [ -z "$pid" ] || [ "$pid" = "$$" ]; then
      continue
    fi

    case "$command" in
      *"$bundle_executable"*) printf '%s\n' "$pid" ;;
    esac
  done
}

terminate_launched_app() {
  local pids=()
  local pid

  while IFS= read -r pid; do
    [ -n "$pid" ] && pids+=("$pid")
  done < <(launched_app_pids)

  if [ "${#pids[@]}" -gt 0 ]; then
    terminate_app_pids "${pids[@]}"
  fi
}

# shellcheck disable=SC2329 # Invoked by cleanup, which runs from traps.
terminate_managed_app() {
  if [ "${#managed_app_pids[@]}" -gt 0 ]; then
    terminate_app_pids "${managed_app_pids[@]}"
  else
    terminate_launched_app
  fi
}

terminate_app_pids() {
  if [ "$#" -eq 0 ]; then
    return 0
  fi

  local pids=("$@")
  local remaining=()
  local pid
  local _

  kill "${pids[@]}" 2>/dev/null || true

  for _ in {1..50}; do
    remaining=()
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        remaining+=("$pid")
      fi
    done

    if [ "${#remaining[@]}" -eq 0 ]; then
      return 0
    fi

    sleep 0.1
  done

  if [ "${#remaining[@]}" -gt 0 ]; then
    kill -9 "${remaining[@]}" 2>/dev/null || true
  fi
}

# If a prior runner was killed during a Tauri rebuild, `open -W` may have
# died while the launched app kept running. Clear that stale copy before the
# next launch so dev hot reload has one backend process.
terminate_launched_app

mkdir -p "$macos_dir" "$resources_dir"
rm -f "$bundle_executable"
cp "$binary" "$bundle_executable"
chmod +x "$bundle_executable"

cat >"$contents_dir/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>claudette-app</string>
  <key>CFBundleIdentifier</key>
  <string>com.claudette.app.dev</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Claudette Dev</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0-dev</string>
  <key>CFBundleVersion</key>
  <string>0</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Claudette uses the microphone for voice input in chat prompts.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Claudette uses speech recognition to convert voice input into chat prompt text.</string>
</dict>
</plist>
PLIST

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$bundle_dir" 2>/dev/null || true
fi

if command -v codesign >/dev/null 2>&1; then
  echo "▸ Signing $bundle_dir with src-tauri/Entitlements.plist"
  codesign --force --deep --sign - \
    --entitlements "$repo_root/src-tauri/Entitlements.plist" \
    "$bundle_dir"
fi

# Launch via Launch Services so the .app is the responsible process for TCC.
# A FIFO pair forwards the launched app's stdout/stderr back to this runner so
# `cargo tauri dev` continues to see compiler-style output and dev logs.
log_dir="$(mktemp -d)"
stdout_fifo="$log_dir/stdout"
stderr_fifo="$log_dir/stderr"
mkfifo "$stdout_fifo" "$stderr_fifo"

# shellcheck disable=SC2329 # Invoked by the EXIT/INT/TERM traps below.
cleanup() {
  terminate_managed_app
  rm -rf "$log_dir"
  if [ -n "${open_pid:-}" ] && kill -0 "$open_pid" 2>/dev/null; then
    kill "$open_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

cat "$stdout_fifo" &
cat_stdout_pid=$!
cat "$stderr_fifo" >&2 &
cat_stderr_pid=$!

env_args=()
for var in VITE_PORT CLAUDETTE_DEBUG_PORT CLAUDETTE_DEV_OVERRIDE RUST_LOG RUST_BACKTRACE; do
  if [ -n "${!var:-}" ]; then
    env_args+=(--env "$var=${!var}")
  fi
done

echo "▸ Launching $bundle_dir via Launch Services"
# `-n` matters for dev loops: the bundle identifier is stable, so Launch
# Services may otherwise activate an already-running Claudette Dev instance
# and return immediately. That makes cargo-tauri tear down Vite, which Bun
# reports as exit 143.
#
# Build the open(1) argv incrementally rather than relying on
# `${arr[@]+"${arr[@]}"}` parameter-substitution tricks. Two reasons:
# (1) `set -u` makes naked `"${empty[@]}"` an "unbound variable" error
#     on bash 3 (still the default /bin/bash on macOS without nix/brew),
#     so we can't just leave the arrays inline.
# (2) Building the array explicitly is unambiguous to the next reader —
#     each element is properly quoted, no mental model of expansion
#     required, and adding a future flag is just an `+=` append.
open_argv=(open -n -W -a "$bundle_dir" --stdout "$stdout_fifo" --stderr "$stderr_fifo")
if [ "${#env_args[@]}" -gt 0 ]; then
  open_argv+=("${env_args[@]}")
fi
open_argv+=(--args)
if [ "${#app_args[@]}" -gt 0 ]; then
  open_argv+=("${app_args[@]}")
fi
"${open_argv[@]}" &
open_pid=$!

for _ in {1..50}; do
  while IFS= read -r pid; do
    already_managed=false
    if [ "${#managed_app_pids[@]}" -gt 0 ]; then
      for managed_pid in "${managed_app_pids[@]}"; do
        if [ "$managed_pid" = "$pid" ]; then
          already_managed=true
          break
        fi
      done
    fi

    if [ "$already_managed" = false ]; then
      managed_app_pids+=("$pid")
    fi
  done < <(launched_app_pids)

  if [ "${#managed_app_pids[@]}" -gt 0 ] || ! kill -0 "$open_pid" 2>/dev/null; then
    break
  fi

  sleep 0.1
done

wait "$open_pid"
exit_code=$?

# Drain any remaining log output before the FIFOs are removed
wait "$cat_stdout_pid" "$cat_stderr_pid" 2>/dev/null || true

exit "$exit_code"
