#!/usr/bin/env bash
# Compile and stage the `claudette-session-host` binary at the path Tauri's
# bundle.externalBin expects: `src-tauri/binaries/claudette-session-host-<triple>`
# (with `.exe` on Windows). Tauri strips the triple suffix at bundle time and
# places the binary alongside the GUI binary in the resulting artifact (.app /
# .deb / AppImage / Windows install dir), where `current_exe().parent()` finds
# it at runtime.
#
# Usage:
#   scripts/stage-session-host-sidecar.sh                         # auto-detect host triple
#   scripts/stage-session-host-sidecar.sh <triple>                # explicit triple (CI)
#   scripts/stage-session-host-sidecar.sh --profile debug         # dev builds
#   scripts/stage-session-host-sidecar.sh <triple> --release-built
#       # don't rebuild; assume `target/<triple>/release/claudette-session-host`
#       # already exists (CI flow where the binary was built in a separate step).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

usage() {
  sed -n '2,14p' "$0" >&2
}

triple=""
profile="release"
release_built=false
triple_explicit=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-built)
      release_built=true
      profile="release"
      ;;
    --profile)
      shift
      if [ "${1:-}" = "" ]; then
        echo "--profile requires 'debug' or 'release'" >&2
        exit 64
      fi
      profile="$1"
      ;;
    --profile=*)
      profile="${1#--profile=}"
      ;;
    --debug)
      profile="debug"
      ;;
    --release)
      profile="release"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "unknown option: $1" >&2
      usage
      exit 64
      ;;
    *)
      if [ "$triple" != "" ]; then
        echo "unexpected extra argument: $1" >&2
        usage
        exit 64
      fi
      triple="$1"
      triple_explicit=true
      ;;
  esac
  shift
done

case "$profile" in
  debug|release) ;;
  *)
    echo "unsupported profile: $profile (expected debug or release)" >&2
    exit 64
    ;;
esac

if [ "$release_built" = "true" ] && [ "$profile" != "release" ]; then
  echo "--release-built can only be used with the release profile" >&2
  exit 64
fi

if [ "$triple" = "" ]; then
  triple="$(rustc -vV | awk '/host:/ {print $2}')"
fi

case "$triple" in
  *windows*) bin_name="claudette-session-host.exe" ;;
  *)         bin_name="claudette-session-host" ;;
esac

if [ "$profile" = "debug" ] && [ "$triple_explicit" != "true" ]; then
  target_bin="target/debug/${bin_name}"
else
  target_bin="target/${triple}/${profile}/${bin_name}"
fi

if [ "$release_built" != "true" ]; then
  echo "▸ Building claudette-session-host (${profile}) for ${triple}"
  cargo_args=(build -p claudette-session-host)
  if [ "$profile" = "release" ] || [ "$triple_explicit" = "true" ]; then
    cargo_args+=(--target "${triple}")
  fi
  if [ "$profile" = "release" ]; then
    cargo_args=(build --release --target "${triple}" -p claudette-session-host)
  fi
  cargo "${cargo_args[@]}"
fi

if [ ! -f "$target_bin" ]; then
  echo "expected built binary not found: $target_bin" >&2
  exit 66
fi

dest_dir="src-tauri/binaries"
mkdir -p "$dest_dir"

case "$triple" in
  *windows*) dest="${dest_dir}/claudette-session-host-${triple}.exe" ;;
  *)         dest="${dest_dir}/claudette-session-host-${triple}" ;;
esac

cp "$target_bin" "$dest"
chmod +x "$dest"
echo "▸ Staged $target_bin -> $dest"
