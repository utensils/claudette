#!/usr/bin/env bash
# latentforge-usage — navigate to Settings → Usage and record the page.
# Showcases Claudette's usage-insights feature (per-workspace / per-model
# token + cost metrics).
#
# Output: /tmp/claudette-capture/latentforge-usage.mp4

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="latentforge-usage"
WS_ID="$(cat "$TMP_DIR/lf-workspace-id")"

log "preflight"
window_require
window_activate
sleep 0.3

log "opening Settings → Usage, closing terminal panel for cleaner frame"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  s.selectWorkspace('$WS_ID');
  // Hide terminal panel so the settings page gets full real estate
  window.__CLAUDETTE_STORE__.setState({ terminalPanelVisible: false });
  // Open settings and jump to Usage
  s.openSettings();
  s.setSettingsSection('usage');
  return { settingsOpen: s.settingsOpen, section: window.__CLAUDETTE_STORE__.getState().settingsSection };
"
sleep 1.6

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# Hold on the usage page
sleep 4.5

log "subtle scroll to show more of the usage content"
eval_js "
  // Find the main settings content pane and scroll
  const pane = document.querySelector('[class*=\"settingsContent\"], [class*=\"settings-content\"], main');
  if (pane) pane.scrollTop = Math.min(pane.scrollHeight - pane.clientHeight, 400);
  return 'scrolled';
" >/dev/null
sleep 3.5

record_stop "$NAME"

log "closing settings after capture"
eval_js "
  const s = window.__CLAUDETTE_STORE__.getState();
  if (s.settingsOpen) s.closeSettings();
  return 'ok';
" >/dev/null

log "encoding → $TMP_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$TMP_DIR/$NAME.mp4"
ls -lah "$TMP_DIR/$NAME.mp4"
