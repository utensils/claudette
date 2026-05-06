#!/usr/bin/env bash
# Stage the `claudette` CLI binary at the path Tauri's `bundle.externalBin`
# expects: `src-tauri/binaries/claudette-<TARGET_TRIPLE>` (with a `.exe`
# suffix on Windows). Tauri strips the suffix at bundle time and places
# the binary alongside the GUI binary in the resulting artifact (.app /
# .deb / AppImage / Windows install dir).
#
# Usage:
#   scripts/stage-cli-sidecar.sh                 # auto-detect host triple
#   scripts/stage-cli-sidecar.sh <triple>        # explicit triple (CI)
#   scripts/stage-cli-sidecar.sh <triple> --release-built
#       # don't rebuild; assume `target/<triple>/release/claudette` already
#       # exists (CI flow where claudette-cli was built in a separate step).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [ "${1:-}" != "" ] && [ "$1" != "--release-built" ]; then
  triple="$1"
  shift
else
  triple="$(rustc -vV | awk '/host:/ {print $2}')"
fi
release_built=false
for arg in "$@"; do
  if [ "$arg" = "--release-built" ]; then release_built=true; fi
done

case "$triple" in
  *windows*) bin_name="claudette.exe" ;;
  *)         bin_name="claudette" ;;
esac

target_bin="target/${triple}/release/${bin_name}"
if [ "$release_built" != "true" ]; then
  echo "▸ Building claudette-cli for ${triple}"
  cargo build --release --target "${triple}" -p claudette-cli
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
