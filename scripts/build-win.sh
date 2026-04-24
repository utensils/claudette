#!/usr/bin/env bash
# Cross-compile claudette.exe for Windows via cargo-xwin.
# Usage: build-win.sh {arm64|x64}
#
# Shared backend for build-win-arm64 / build-win-x64 devshell commands.
# See flake.nix devshell notes for why we invoke `cargo xwin` directly
# (--features tauri/custom-protocol, --release, target triple).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

case "${1:-}" in
  arm64) TRIPLE=aarch64-pc-windows-msvc ;;
  x64)   TRIPLE=x86_64-pc-windows-msvc ;;
  *) echo "usage: $0 {arm64|x64}" >&2; exit 2 ;;
esac

(cd src/ui && bun install --frozen-lockfile && bun run build)

# Regenerate platform icons from the PNG master. `icon.ico` / `icon.icns` are
# listed in `tauri.conf.json` but gitignored — tauri-build requires the .ico
# at link time on Windows to embed the PE resource, so it must exist before
# we invoke `cargo xwin`. CI does the equivalent in ci.yml / nightly.yml /
# release-please.yml via `npx @tauri-apps/cli icon`.
cargo tauri icon assets/logo.png

cargo xwin build --release \
  --features tauri/custom-protocol \
  --target "$TRIPLE" -p claudette-tauri
echo
echo "Built: $REPO_ROOT/target/$TRIPLE/release/claudette.exe"
