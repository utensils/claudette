#!/usr/bin/env bash
# cargo-tauri runner for macOS development builds.
#
# TCC speech permissions require the dev binary to be signed with the same
# entitlements as the packaged macOS app. Tauri passes Cargo-style arguments to
# --runner, so this script builds, signs, and then execs the real binary.
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
    binary="$target_dir/$target_triple/$profile/claudette"
  else
    binary="$target_dir/$profile/claudette"
  fi
fi

if [ ! -f "$binary" ]; then
  echo "built binary not found: $binary" >&2
  exit 66
fi

if command -v codesign >/dev/null 2>&1; then
  echo "▸ Signing macOS dev binary with src-tauri/Entitlements.plist"
  codesign --force --sign - --entitlements "$repo_root/src-tauri/Entitlements.plist" "$binary"
fi

echo "▸ Launching $binary"
exec "$binary" "${app_args[@]}"
