#!/usr/bin/env bash
# Build + deploy claudette.exe to a Windows target.
# Usage: deploy-win.sh {arm64|x64}
#
# - arm64: defaults to James's local test VM at 172.16.52.129, OneDrive
#   redirected Desktop path.
# - x64:  defaults to the newest aws-win-spinup instance (auto-discovered
#   via AWS tag if CLAUDETTE_WIN_HOST isn't set), plain Desktop path.
#
# Env overrides: CLAUDETTE_WIN_HOST, CLAUDETTE_WIN_REMOTE_PATH.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

case "${1:-}" in
  arm64)
    TRIPLE=aarch64-pc-windows-msvc
    DEFAULT_HOST="brink@172.16.52.129"
    DEFAULT_REMOTE="OneDrive/Desktop/claudette.exe"
    ;;
  x64)
    TRIPLE=x86_64-pc-windows-msvc
    DEFAULT_REMOTE="Desktop/claudette.exe"
    # Auto-discover the AWS host if the caller didn't export one.
    if [ -z "${CLAUDETTE_WIN_HOST:-}" ]; then
      # shellcheck source=_aws-common.sh
      source "$SCRIPT_DIR/_aws-common.sh"
      ID=$(discover_instance)
      if [ -n "$ID" ]; then
        IP=$(instance_public_ip "$ID")
        [ -n "$IP" ] && [ "$IP" != "None" ] && DEFAULT_HOST="Administrator@$IP"
      fi
      : "${DEFAULT_HOST:=}"
    fi
    ;;
  *) echo "usage: $0 {arm64|x64}" >&2; exit 2 ;;
esac

HOST="${CLAUDETTE_WIN_HOST:-${DEFAULT_HOST:-}}"
REMOTE_PATH="${CLAUDETTE_WIN_REMOTE_PATH:-$DEFAULT_REMOTE}"
if [ -z "$HOST" ]; then
  echo "error: no deploy host — set CLAUDETTE_WIN_HOST or run aws-win-spinup first" >&2
  exit 1
fi

"$SCRIPT_DIR/build-win.sh" "$1"

echo
echo "Stopping running claudette on $HOST (if any)..."
# `|| true`: Windows OpenSSH can report non-zero even with
# -ErrorAction SilentlyContinue in some edge cases, and the remote
# Stop-Process failing shouldn't abort the scp step below.
ssh -o StrictHostKeyChecking=accept-new "$HOST" \
  'Stop-Process -Name claudette -Force -ErrorAction SilentlyContinue' || true
echo "Copying to $HOST:$REMOTE_PATH ..."
scp -o StrictHostKeyChecking=accept-new \
  "target/$TRIPLE/release/claudette.exe" "$HOST:$REMOTE_PATH"
echo
echo "Deployed. Double-click claudette.exe on the remote Desktop to run."
