#!/usr/bin/env bash
# cargo-tauri runner for macOS development builds.
#
# TCC speech permissions can abort raw executables before errors are
# recoverable. Running the dev binary from a real .app bundle gives macOS the
# Info.plist privacy strings it requires for Speech and microphone prompts.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: macos-dev-app-runner.sh <binary> [args...]" >&2
  exit 64
fi

binary="$1"
shift

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
bundle_dir="${CLAUDETTE_DEV_APP_BUNDLE:-$repo_root/target/debug/Claudette Dev.app}"
contents_dir="$bundle_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
bundle_executable="$macos_dir/claudette"

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
  <string>claudette</string>
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
  if ! codesign --force --deep --sign - "$bundle_dir" >/dev/null 2>&1; then
    echo "warning: failed to ad-hoc sign $bundle_dir" >&2
  fi
fi

exec "$bundle_executable" "$@"
