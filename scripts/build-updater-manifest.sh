#!/usr/bin/env bash
set -euo pipefail

# Build a Tauri updater manifest (`latest.json`) from a directory of
# per-platform `.sig` files.
#
# Why this exists: tauri-action would normally emit `latest.json` in-band
# during each matrix leg's release-upload step. Doing that from parallel
# matrix legs races on the GitHub Releases API — each leg downloads the
# current manifest, merges its own platform's entry in, and uploads
# back. When two legs read before either writes, the later upload
# silently clobbers the earlier merge, dropping a platform from the
# manifest. (See run #25543925342: linux-x86_64 lost the `already_exists`
# race outright, and `darwin-aarch64` was clobbered by macos-x86_64 even
# though both jobs "succeeded".)
#
# Centralizing the manifest build into a single post-build step removes
# the race while producing a byte-equivalent manifest to what
# tauri-action emits.
#
# Required positional arguments:
#   $1 - directory containing per-platform `*.sig` files (one signature
#        per file, format identical to what `tauri-build` writes)
#   $2 - version string to embed in the manifest (e.g.
#        `0.24.0-dev.46.g9153d99`)
#   $3 - asset URL prefix (e.g.
#        `https://github.com/owner/repo/releases/download/nightly`)
#
# Recognized .sig filename patterns and the manifest keys they populate
# (mirrors what tauri-action emits — the "bare" platform key duplicates
# the default-format variant for compatibility with both Tauri 1.x and
# 2.x updater clients):
#   *_amd64.AppImage.sig             -> linux-x86_64, linux-x86_64-appimage
#   *_amd64.deb.sig                  -> linux-x86_64-deb
#   *_aarch64.AppImage.sig           -> linux-aarch64, linux-aarch64-appimage
#   *_arm64.deb.sig                  -> linux-aarch64-deb
#   Claudette_x64.app.tar.gz.sig     -> darwin-x86_64, darwin-x86_64-app
#   Claudette_aarch64.app.tar.gz.sig -> darwin-aarch64, darwin-aarch64-app

usage() {
  echo "usage: $0 <sig-dir> <version> <url-prefix>" >&2
  exit 64
}

[ "$#" -eq 3 ] || usage
SIG_DIR="$1"
VERSION="$2"
URL_PREFIX="$3"

[ -d "$SIG_DIR" ] || {
  echo "::error::$SIG_DIR is not a directory" >&2
  exit 1
}

declare -A PLATFORMS

shopt -s nullglob
for sig in "$SIG_DIR"/*.sig; do
  asset="$(basename "$sig" .sig)"
  case "$asset" in
    *_amd64.AppImage)
      PLATFORMS[linux-x86_64]="$asset"
      PLATFORMS[linux-x86_64-appimage]="$asset"
      ;;
    *_amd64.deb)
      PLATFORMS[linux-x86_64-deb]="$asset"
      ;;
    *_aarch64.AppImage)
      PLATFORMS[linux-aarch64]="$asset"
      PLATFORMS[linux-aarch64-appimage]="$asset"
      ;;
    *_arm64.deb)
      PLATFORMS[linux-aarch64-deb]="$asset"
      ;;
    Claudette_x64.app.tar.gz)
      PLATFORMS[darwin-x86_64]="$asset"
      PLATFORMS[darwin-x86_64-app]="$asset"
      ;;
    Claudette_aarch64.app.tar.gz)
      PLATFORMS[darwin-aarch64]="$asset"
      PLATFORMS[darwin-aarch64-app]="$asset"
      ;;
    *)
      echo "warn: unrecognized .sig file: $asset" >&2
      ;;
  esac
done
shopt -u nullglob

# Hard-fail if any required platform key is missing — better to abort
# the promotion than to publish a manifest where some platforms can't
# auto-update. The publish job already short-circuits when any matrix
# leg failed (via `needs.build.result == 'success'`), so reaching this
# script with a missing .sig file would indicate something else has
# gone wrong upstream.
declare -a REQUIRED=(
  "linux-x86_64"
  "linux-x86_64-appimage"
  "linux-x86_64-deb"
  "linux-aarch64"
  "linux-aarch64-appimage"
  "linux-aarch64-deb"
  "darwin-x86_64"
  "darwin-x86_64-app"
  "darwin-aarch64"
  "darwin-aarch64-app"
)
for key in "${REQUIRED[@]}"; do
  if [ -z "${PLATFORMS[$key]:-}" ]; then
    echo "::error::missing platform entry: $key (no matching .sig file in $SIG_DIR)" >&2
    exit 1
  fi
done

# Build the platforms object iteratively. `jq --rawfile` reads the .sig
# file content as a JSON-escaped string, so embedded newlines and the
# trailing newline are handled correctly without any base64 / sed
# massaging — the .sig file's contents go into the manifest verbatim,
# matching tauri-action's output byte-for-byte.
platforms='{}'
for key in "${REQUIRED[@]}"; do
  asset="${PLATFORMS[$key]}"
  platforms="$(jq \
    --arg key "$key" \
    --rawfile sig "$SIG_DIR/$asset.sig" \
    --arg url "$URL_PREFIX/$asset" \
    '. + {($key): {signature: $sig, url: $url}}' \
    <<<"$platforms")"
done

PUB_DATE="$(date -u +%FT%T.000Z)"

jq -n \
  --arg version "$VERSION" \
  --arg pub_date "$PUB_DATE" \
  --argjson platforms "$platforms" \
  '{version: $version, notes: "", pub_date: $pub_date, platforms: $platforms}'
