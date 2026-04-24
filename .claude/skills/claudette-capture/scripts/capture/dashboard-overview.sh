#!/usr/bin/env bash
# dashboard-overview — steady shot of the dashboard with a slow theme transition.
# Output: site/src/assets/screenshots/dashboard-overview.mp4
# Duration: ~6s

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="dashboard-overview"

log "preflight"
window_require
window_activate
sleep 0.3

log "seeding: dark theme, sidebar open, no workspace selected"
eval_js "window.capture.setTheme('default-dark'); window.capture.seedState({ sidebarVisible: true, rightSidebarVisible: false, selectedWorkspaceId: null }); return 'ok';"
sleep 0.8

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# 2s on default-dark
sleep 2.2
eval_js "window.capture.setTheme('rose-pine'); return 'ok';" >/dev/null
# 2s on rose-pine
sleep 2.2
eval_js "window.capture.setTheme('default-dark'); return 'ok';" >/dev/null
# 1.5s back on default-dark
sleep 1.5

record_stop "$NAME"

log "encoding → $OUT_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$OUT_DIR/$NAME.mp4"
ls -lah "$OUT_DIR/$NAME.mp4"
