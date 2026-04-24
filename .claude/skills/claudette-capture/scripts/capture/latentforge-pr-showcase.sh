#!/usr/bin/env bash
# latentforge-pr-showcase — after the agent has finished (committed, pushed,
# opened a PR), show the SCM section and PR status in the right sidebar.
# Output: /tmp/claudette-capture/latentforge-pr-showcase.mp4
# Duration: ~12s

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="latentforge-pr-showcase"
WS_ID="$(cat "$TMP_DIR/lf-workspace-id")"

log "preflight"
window_require
window_activate
sleep 0.4

log "ensuring workspace selected, sidebar + right sidebar open"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  s.selectWorkspace('$WS_ID');
  document.documentElement.setAttribute('data-theme', 'default-dark');
  s.setCurrentThemeId('default-dark');
  // Ensure right sidebar (Changes/SCM) visible and tab is 'changes'
  if (!s.rightSidebarVisible) s.toggleRightSidebar();
  s.setRightSidebarTab('changes');
  return 'ok';
"
sleep 1.2

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# Hold: show chat w/ completed agent + SCM sidebar on right
sleep 3.5

log "switching right sidebar tab: changes → commits → changes"
eval_js "window.__CLAUDETTE_STORE__.getState().setRightSidebarTab('commits'); return 'ok';" >/dev/null
sleep 2.5

eval_js "window.__CLAUDETTE_STORE__.getState().setRightSidebarTab('changes'); return 'ok';" >/dev/null
sleep 2.5

log "opening terminal panel briefly to showcase gh CLI output"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  if (!s.terminalPanelVisible) s.toggleTerminalPanel();
  return 'ok';
" >/dev/null
sleep 2.8

record_stop "$NAME"

log "encoding → $OUT_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$OUT_DIR/$NAME.mp4"
ls -lah "$OUT_DIR/$NAME.mp4"
