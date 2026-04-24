#!/usr/bin/env bash
# settings-tour — opens Settings and steps through a few sections to show configuration depth.
# Output: site/src/assets/screenshots/settings-tour.mp4
# Duration: ~9s

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="settings-tour"

log "preflight"
window_require
window_activate
sleep 0.3

log "seeding: default-dark, settings closed, dashboard focused"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  window.capture.setTheme('default-dark');
  if (s.settingsOpen) s.closeSettings();
  return { settingsOpen: window.__CLAUDETTE_STORE__.getState().settingsOpen };
"
sleep 0.8

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# 1.2s on dashboard
sleep 1.2

# Open settings
eval_js "window.__CLAUDETTE_STORE__.getState().openSettings(); return 'ok';" >/dev/null
sleep 1.5

# Step through sections
for section in appearance git plugins agents mcp; do
  eval_js "window.__CLAUDETTE_STORE__.getState().setSettingsSection('$section'); return '$section';" >/dev/null
  sleep 1.4
done

# Close settings
eval_js "window.__CLAUDETTE_STORE__.getState().closeSettings(); return 'ok';" >/dev/null
sleep 0.8

record_stop "$NAME"

log "encoding → $OUT_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$OUT_DIR/$NAME.mp4"
ls -lah "$OUT_DIR/$NAME.mp4"
