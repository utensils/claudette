#!/usr/bin/env bash
# Window helpers — find and focus the running Claudette dev build.
# Exports: window_bounds (echoes "x,y,w,h"), window_activate

set -euo pipefail

window_bounds() {
  osascript <<'OSA'
tell application "System Events"
  tell first process whose name is "claudette"
    set pos to position of window 1
    set sz to size of window 1
    set x to item 1 of pos as integer
    set y to item 2 of pos as integer
    set w to item 1 of sz as integer
    set h to item 2 of sz as integer
    set AppleScript's text item delimiters to ","
    return {x, y, w, h} as text
  end tell
end tell
OSA
}

window_activate() {
  osascript -e 'tell application "System Events" to set frontmost of first process whose name is "claudette" to true' >/dev/null
}

# Guard: refuses to run if no claudette process found.
window_require() {
  if ! pgrep -x claudette >/dev/null; then
    echo "error: no 'claudette' process running. Start the dev build first." >&2
    exit 1
  fi
}
