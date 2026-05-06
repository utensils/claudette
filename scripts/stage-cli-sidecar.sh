#!/usr/bin/env bash
# Stage the `claudette` CLI binary at the path Tauri's `bundle.externalBin`
# expects: `src-tauri/binaries/claudette-<TARGET_TRIPLE>` (with a `.exe`
# suffix on Windows). Tauri strips the suffix at bundle time and places
# the binary alongside the GUI binary in the resulting artifact (.app /
# .deb / AppImage / Windows install dir).
#
# Usage:
#   scripts/stage-cli-sidecar.sh                         # auto-detect host triple
#   scripts/stage-cli-sidecar.sh <triple>                # explicit triple (CI)
#   scripts/stage-cli-sidecar.sh --profile debug         # dev builds
#   scripts/stage-cli-sidecar.sh <triple> --release-built
#       # don't rebuild; assume `target/<triple>/release/claudette` already
#       # exists (CI flow where claudette-cli was built in a separate step).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

usage() {
  sed -n '2,13p' "$0" >&2
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
  *windows*) bin_name="claudette.exe" ;;
  *)         bin_name="claudette" ;;
esac

if [ "$profile" = "debug" ] && [ "$triple_explicit" != "true" ]; then
  target_bin="target/debug/${bin_name}"
else
  target_bin="target/${triple}/${profile}/${bin_name}"
fi

if [ "$release_built" != "true" ]; then
  echo "▸ Building claudette-cli (${profile}) for ${triple}"
  cargo_args=(build -p claudette-cli)
  if [ "$profile" = "release" ] || [ "$triple_explicit" = "true" ]; then
    cargo_args+=(--target "${triple}")
  fi
  if [ "$profile" = "release" ]; then
    cargo_args=(build --release --target "${triple}" -p claudette-cli)
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
  *windows*) dest="${dest_dir}/claudette-${triple}.exe" ;;
  *)         dest="${dest_dir}/claudette-${triple}" ;;
esac

cp "$target_bin" "$dest"
chmod +x "$dest"
echo "▸ Staged $target_bin -> $dest"
