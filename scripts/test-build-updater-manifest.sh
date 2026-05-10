#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

write_sig() {
  printf 'signature for %s\n' "$1" > "$TMP/$1.sig"
}

write_sig "Claudette_0.24.0_amd64.AppImage"
write_sig "Claudette_0.24.0_amd64.deb"
write_sig "Claudette_0.24.0_aarch64.AppImage"
write_sig "Claudette_0.24.0_arm64.deb"
write_sig "Claudette_x64.app.tar.gz"
write_sig "Claudette_aarch64.app.tar.gz"
write_sig "Claudette_0.24.0_x64-setup.exe"
write_sig "Claudette_0.24.0_arm64-setup.exe"

manifest="$("$ROOT/scripts/build-updater-manifest.sh" "$TMP" "0.24.0" "https://example.invalid/releases/download/v0.24.0")"

for key in \
  linux-x86_64 linux-x86_64-appimage linux-x86_64-deb \
  linux-aarch64 linux-aarch64-appimage linux-aarch64-deb \
  darwin-x86_64 darwin-x86_64-app darwin-aarch64 darwin-aarch64-app \
  windows-x86_64 windows-x86_64-nsis windows-aarch64 windows-aarch64-nsis
do
  jq -e --arg key "$key" '.platforms[$key].url and .platforms[$key].signature' <<<"$manifest" >/dev/null
done

rm "$TMP/Claudette_0.24.0_x64-setup.exe.sig"
if "$ROOT/scripts/build-updater-manifest.sh" "$TMP" "0.24.0" "https://example.invalid/releases/download/v0.24.0" >/dev/null 2>&1; then
  echo "manifest builder should fail when a required Windows updater signature is missing" >&2
  exit 1
fi

echo "build-updater-manifest tests passed"
