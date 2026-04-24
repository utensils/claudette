#!/usr/bin/env bash
# theme-cycle — cycles through a handful of themes on the dashboard.
# Output: site/src/assets/screenshots/theme-cycle.mp4
# Duration: ~10s (5 themes × 1.8s each)

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="theme-cycle"
THEMES=("default-dark" "rose-pine" "jellybeans" "solarized-light" "brink")
DWELL=1.8

log "preflight"
window_require
window_activate
sleep 0.3

log "seeding: dashboard view, sidebar open, first theme"
eval_js "window.capture.setTheme('${THEMES[0]}'); window.capture.seedState({ sidebarVisible: true, rightSidebarVisible: false, selectedWorkspaceId: null }); return window.capture.summary();"
sleep 0.6

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

for t in "${THEMES[@]}"; do
  log "  theme → $t"
  eval_js "window.capture.setTheme('$t'); return '$t';" >/dev/null
  sleep "$DWELL"
done

record_stop "$NAME"

log "encoding → $OUT_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$OUT_DIR/$NAME.mp4"
ls -lah "$OUT_DIR/$NAME.mp4"

log "restoring default-dark theme"
eval_js "window.capture.setTheme('default-dark'); return 'ok';" >/dev/null
