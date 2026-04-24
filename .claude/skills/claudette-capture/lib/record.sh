#!/usr/bin/env bash
# Recorder — wraps `screencapture -v -R x,y,w,h` for window-bounded MP4 recording.
# Usage:
#   record_start <name>   — begin recording, writes /tmp/claudette-capture/<name>.mov
#   record_stop  <name>   — SIGINT the recorder, wait for .mov to flush

set -euo pipefail

# shellcheck disable=SC2034
CAPTURE_TMP="/tmp/claudette-capture"
mkdir -p "$CAPTURE_TMP"

record_start() {
  local name="$1"
  local bounds="${2:-}"
  if [[ -z "$bounds" ]]; then
    # shellcheck disable=SC1091
    source "$(dirname "${BASH_SOURCE[0]}")/window.sh"
    bounds="$(window_bounds)"
  fi
  local mov="$CAPTURE_TMP/$name.mov"
  local pidfile="$CAPTURE_TMP/$name.pid"
  rm -f "$mov" "$pidfile"
  # -v video, -R x,y,w,h region, -o no sound, -x no UI sound, -C capture cursor
  # -g do not play sounds
  screencapture -v -g -C -R "$bounds" "$mov" &
  local pid=$!
  echo "$pid" > "$pidfile"
  # small buffer for recording to initialize
  sleep 0.5
}

record_stop() {
  local name="$1"
  local pidfile="$CAPTURE_TMP/$name.pid"
  local mov="$CAPTURE_TMP/$name.mov"
  if [[ ! -f "$pidfile" ]]; then
    echo "error: no pidfile at $pidfile" >&2
    return 1
  fi
  local pid
  pid="$(cat "$pidfile")"
  # SIGINT is screencapture -v's documented clean-stop signal.
  kill -INT "$pid" 2>/dev/null || true
  # Wait for process to exit (flushes the .mov)
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.1
    i=$((i + 1))
    if (( i > 50 )); then
      kill -TERM "$pid" 2>/dev/null || true
      break
    fi
  done
  rm -f "$pidfile"
  if [[ ! -s "$mov" ]]; then
    echo "error: recording $mov is empty" >&2
    return 1
  fi
  echo "$mov"
}
