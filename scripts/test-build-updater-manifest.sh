#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_case() {
  local label="$1"; shift
  local tmp; tmp="$(mktemp -d)"
  trap "rm -rf '$tmp'" RETURN
  for asset in "$@"; do
    printf 'signature for %s\n' "$asset" > "$tmp/$asset.sig"
  done
  "$ROOT/scripts/build-updater-manifest.sh" "$tmp" "0.24.0" "https://example.invalid/releases/download/v0.24.0"
}

# ---- case 1: full matrix with AppImage present (legacy default) ------
manifest="$(run_case full-matrix \
  Claudette_0.24.0_amd64.AppImage \
  Claudette_0.24.0_amd64.deb \
  Claudette_0.24.0_aarch64.AppImage \
  Claudette_0.24.0_arm64.deb \
  Claudette_x64.app.tar.gz \
  Claudette_aarch64.app.tar.gz \
  Claudette_0.24.0_x64-setup.exe \
  Claudette_0.24.0_arm64-setup.exe)"

for key in \
  linux-x86_64 linux-x86_64-appimage linux-x86_64-deb \
  linux-aarch64 linux-aarch64-appimage linux-aarch64-deb \
  darwin-x86_64 darwin-x86_64-app darwin-aarch64 darwin-aarch64-app \
  windows-x86_64 windows-x86_64-nsis windows-aarch64 windows-aarch64-nsis
do
  jq -e --arg key "$key" '.platforms[$key].url and .platforms[$key].signature' <<<"$manifest" >/dev/null
done

# With AppImage present, the generic linux-x86_64 key must point at the
# AppImage URL — .deb's `:=` fallback must not override.
url="$(jq -r '.platforms["linux-x86_64"].url' <<<"$manifest")"
case "$url" in
  *.AppImage) ;;
  *)
    echo "case 1: linux-x86_64 should resolve to AppImage when present, got $url" >&2
    exit 1
    ;;
esac

# ---- case 2: Linux ships .deb only (post-#824 nightly/release) ------
manifest="$(run_case deb-only \
  Claudette_0.24.0_amd64.deb \
  Claudette_0.24.0_arm64.deb \
  Claudette_x64.app.tar.gz \
  Claudette_aarch64.app.tar.gz \
  Claudette_0.24.0_x64-setup.exe \
  Claudette_0.24.0_arm64-setup.exe)"

for key in \
  linux-x86_64 linux-x86_64-deb \
  linux-aarch64 linux-aarch64-deb \
  darwin-x86_64 darwin-x86_64-app darwin-aarch64 darwin-aarch64-app \
  windows-x86_64 windows-x86_64-nsis windows-aarch64 windows-aarch64-nsis
do
  jq -e --arg key "$key" '.platforms[$key].url and .platforms[$key].signature' <<<"$manifest" >/dev/null
done

# The generic key must now fall back to the .deb URL.
url="$(jq -r '.platforms["linux-x86_64"].url' <<<"$manifest")"
case "$url" in
  *.deb) ;;
  *)
    echo "case 2: linux-x86_64 should fall back to .deb when AppImage is absent, got $url" >&2
    exit 1
    ;;
esac

# ---- case 3: missing required Windows sig still fails ---------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for asset in \
  Claudette_0.24.0_amd64.deb \
  Claudette_0.24.0_arm64.deb \
  Claudette_x64.app.tar.gz \
  Claudette_aarch64.app.tar.gz \
  Claudette_0.24.0_arm64-setup.exe
do
  printf 'sig\n' > "$tmp/$asset.sig"
done
if "$ROOT/scripts/build-updater-manifest.sh" "$tmp" "0.24.0" "https://example.invalid/releases/download/v0.24.0" >/dev/null 2>&1; then
  echo "manifest builder should fail when a required Windows updater signature is missing" >&2
  exit 1
fi

echo "build-updater-manifest tests passed"
