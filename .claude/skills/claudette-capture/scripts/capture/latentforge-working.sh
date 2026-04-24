#!/usr/bin/env bash
# latentforge-working — records while the agent is mid-implementation. Opens
# the terminal panel + creates a terminal tab; runs a read-only `git log` /
# `ls` loop in it to visibly show output; switches the right sidebar to
# Changes so new files appear as the agent writes them.
#
# Run this script while the agent is still Running. It's safe to invoke
# multiple times — each run produces a fresh .mp4.
#
# Output: /tmp/claudette-capture/latentforge-working.mp4
# Duration: ~12s

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="latentforge-working"
WS_ID="$(cat "$TMP_DIR/lf-workspace-id")"

log "preflight"
window_require
window_activate
sleep 0.3

log "opening right sidebar (Changes) + terminal panel with a tab"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  s.selectWorkspace('$WS_ID');
  // Right sidebar: Changes
  if (!s.rightSidebarVisible) s.toggleRightSidebar();
  s.setRightSidebarTab('changes');
  // Terminal panel: ensure visible and has a tab
  window.__CLAUDETTE_STORE__.setState({ terminalPanelVisible: true });
  const existing = s.terminalTabs['$WS_ID'] || [];
  if (existing.length === 0) {
    const tab = await window.__CLAUDETTE_INVOKE__('create_terminal_tab', { workspaceId: '$WS_ID' });
    s.addTerminalTab('$WS_ID', tab);
  }
  return {
    terminalVisible: window.__CLAUDETTE_STORE__.getState().terminalPanelVisible,
    rightSidebar: window.__CLAUDETTE_STORE__.getState().rightSidebarTab,
    tabCount: (window.__CLAUDETTE_STORE__.getState().terminalTabs['$WS_ID'] || []).length,
  };
"
sleep 1.2

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# Hold current frame (terminal + changes + chat all visible)
sleep 4.0

log "switching to commits tab to show early commits"
eval_js "window.__CLAUDETTE_STORE__.getState().setRightSidebarTab('commits'); return 'ok';" >/dev/null
sleep 4.0

log "back to changes tab"
eval_js "window.__CLAUDETTE_STORE__.getState().setRightSidebarTab('changes'); return 'ok';" >/dev/null
sleep 4.0

record_stop "$NAME"

log "encoding → $TMP_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$TMP_DIR/$NAME.mp4"
ls -lah "$TMP_DIR/$NAME.mp4"
