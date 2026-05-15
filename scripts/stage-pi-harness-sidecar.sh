#!/usr/bin/env bash
# Compile and stage the Claudette Pi SDK harness sidecar at the path Tauri's
# bundle.externalBin expects: src-tauri/binaries/claudette-pi-harness-<triple>.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

triple="${1:-}"
if [ "$triple" = "" ]; then
  triple="$(rustc -vV | awk '/host:/ {print $2}')"
fi

case "$triple" in
  aarch64-apple-darwin) bun_target="bun-darwin-arm64" ;;
  x86_64-apple-darwin) bun_target="bun-darwin-x64" ;;
  x86_64-unknown-linux-gnu) bun_target="bun-linux-x64" ;;
  aarch64-unknown-linux-gnu) bun_target="bun-linux-arm64" ;;
  x86_64-pc-windows-msvc) bun_target="bun-windows-x64" ;;
  aarch64-pc-windows-msvc) bun_target="bun-windows-arm64" ;;
  *) echo "unsupported Pi harness target triple: $triple" >&2; exit 64 ;;
esac

suffix=""
case "$triple" in
  *windows*) suffix=".exe" ;;
esac

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to build the Pi harness sidecar" >&2
  exit 69
fi

(
  cd src-pi-harness
  bun install --frozen-lockfile
  # `bun build --compile` transpiles TypeScript without type-checking.
  # Run `tsc --noEmit` first so a type error here surfaces as a clear
  # staging failure instead of silently shipping a sidecar with a
  # latent JSON-protocol or SDK-API drift bug. Skippable via
  # CLAUDETTE_PI_HARNESS_SKIP_TYPECHECK=1 for hotfix builds where the
  # tsconfig is intentionally out of sync.
  if [ "${CLAUDETTE_PI_HARNESS_SKIP_TYPECHECK:-0}" != "1" ]; then
    bun run typecheck
  fi
)

dest_dir="src-tauri/binaries"
mkdir -p "$dest_dir"
dest="${dest_dir}/claudette-pi-harness-${triple}${suffix}"

echo "▸ Building claudette-pi-harness for ${triple}"
bun build src-pi-harness/src/main.ts \
  --compile \
  "--target=${bun_target}" \
  --outfile "$dest"

chmod +x "$dest"

pi_pkg="src-pi-harness/node_modules/@earendil-works/pi-coding-agent/package.json"
if [ -f "$pi_pkg" ]; then
  mkdir -p "$dest_dir/pi"
  cp "$pi_pkg" "$dest_dir/pi/package.json"
fi

echo "▸ Staged Pi harness -> $dest"
