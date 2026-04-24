#!/usr/bin/env bash
# latentforge-pr-showcase — after the agent has finished, show the SCM
# sidebar, then expand the completed-turn tool-call summary briefly to show
# the full list of tools Claude ran, and collapse it again.
#
# Output: /tmp/claudette-capture/latentforge-pr-showcase.mp4
# Duration: ~14s

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="latentforge-pr-showcase"
WS_ID="$(cat "$TMP_DIR/lf-workspace-id")"

log "preflight"
window_require
window_activate
sleep 0.4

log "ensuring workspace selected, right sidebar open, terminal closed"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  s.selectWorkspace('$WS_ID');
  document.documentElement.setAttribute('data-theme', 'default-dark');
  s.setCurrentThemeId('default-dark');
  if (!s.rightSidebarVisible) s.toggleRightSidebar();
  s.setRightSidebarTab('changes');
  window.__CLAUDETTE_STORE__.setState({ terminalPanelVisible: false });
  // Scroll chat to bottom so the final message + turn summary are in view
  const c = document.querySelector('[class*=\"messages_\"]');
  if (c) c.scrollTop = c.scrollHeight;
  return 'ok';
"
sleep 1.4

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# 1. Open hold: chat + final message + SCM sidebar
sleep 2.5

# 2. Expand the completed-turn tool call summary (local component state,
#    toggled by clicking the turn summary chevron)
log "expanding completed-turn tool-call summary"
eval_js "
  // Find a turn summary in the chat — any role-button with 'tool call' label
  const candidates = Array.from(document.querySelectorAll('[class*=\"turnSummary\"]'));
  // Last one is the most recent turn; click to toggle
  const last = candidates[candidates.length - 1];
  if (last) {
    last.click();
    last.scrollIntoView({ block: 'center', behavior: 'instant' });
    return 'expanded (' + candidates.length + ' turns found)';
  }
  return 'no turn summary found';
" >/dev/null
sleep 3.2

log "collapsing turn summary again"
eval_js "
  const candidates = Array.from(document.querySelectorAll('[class*=\"turnSummary\"]'));
  const last = candidates[candidates.length - 1];
  if (last) last.click();
  return 'collapsed';
" >/dev/null
sleep 1.2

# 3. Cycle right sidebar: changes → commits → changes
log "changes → commits → changes"
eval_js "window.__CLAUDETTE_STORE__.getState().setRightSidebarTab('commits'); return 'ok';" >/dev/null
sleep 2.5

eval_js "window.__CLAUDETTE_STORE__.getState().setRightSidebarTab('changes'); return 'ok';" >/dev/null
sleep 1.8

record_stop "$NAME"

log "encoding → $OUT_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$OUT_DIR/$NAME.mp4"
ls -lah "$OUT_DIR/$NAME.mp4"
