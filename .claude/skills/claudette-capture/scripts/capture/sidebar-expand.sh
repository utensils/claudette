#!/usr/bin/env bash
# sidebar-expand — toggles "show archived" on then off, revealing a populated workspace list,
# and cycles the group-by. Shows the sidebar's structure at a glance.
# Output: site/src/assets/screenshots/sidebar-expand.mp4
# Duration: ~7s

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="sidebar-expand"

log "preflight"
window_require
window_activate
sleep 0.3

log "seeding: default-dark, sidebar open, archived hidden, group-by repo"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  window.capture.setTheme('default-dark');
  window.capture.seedState({ sidebarVisible: true, rightSidebarVisible: false, selectedWorkspaceId: null });
  s.setSidebarShowArchived(false);
  s.setSidebarGroupBy('repo');
  return 'ok';
"
sleep 0.8

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# Hold: quiet baseline
sleep 1.8

# Reveal archived workspaces
eval_js "window.__CLAUDETTE_STORE__.getState().setSidebarShowArchived(true); return 'ok';" >/dev/null
sleep 2.2

# Switch group-by
eval_js "window.__CLAUDETTE_STORE__.getState().setSidebarGroupBy('status'); return 'ok';" >/dev/null
sleep 1.8

# Back to repo grouping
eval_js "window.__CLAUDETTE_STORE__.getState().setSidebarGroupBy('repo'); return 'ok';" >/dev/null
sleep 1.2

record_stop "$NAME"

log "restoring default sidebar state"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  s.setSidebarShowArchived(false);
  s.setSidebarGroupBy('repo');
  return 'ok';
" >/dev/null

log "encoding → $OUT_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$OUT_DIR/$NAME.mp4"
ls -lah "$OUT_DIR/$NAME.mp4"
