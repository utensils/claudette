#!/usr/bin/env bash
# latentforge-plan-approval — polls for planApprovals[wsId], expands the plan
# card so the plan markdown is on-screen for ~8s, then approves.
#
# Output: /tmp/claudette-capture/latentforge-plan-approval.mp4

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="latentforge-plan-approval"
WS_ID="$(cat "$TMP_DIR/lf-workspace-id")"
TIMEOUT="${TIMEOUT:-600}"

log "polling for plan approval on $WS_ID (timeout ${TIMEOUT}s)"
start=$(date +%s)
while true; do
  result=$(eval_js "
    const s = window.__CLAUDETTE_STORE__.getState();
    const p = s.planApprovals['$WS_ID'];
    const ws = s.workspaces.find(w => w.id === '$WS_ID');
    return {
      hasPlan: !!p,
      toolUseId: p ? p.toolUseId : null,
      agentStatus: ws?.agent_status,
    };
  ")
  hasPlan=$(echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hasPlan"])')
  if [[ "$hasPlan" == "True" ]]; then
    log "plan arrived"
    echo "$result"
    break
  fi
  elapsed=$(( $(date +%s) - start ))
  if (( elapsed > TIMEOUT )); then
    echo "error: timed out waiting for plan approval after ${TIMEOUT}s" >&2
    exit 1
  fi
  sleep 4
done

TOOL_USE_ID=$(echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["toolUseId"])')
log "toolUseId=$TOOL_USE_ID"

log "scrolling chat to bottom to show the plan card"
eval_js "
  const c = document.querySelector('[class*=\"messages_\"]');
  if (c) c.scrollTop = c.scrollHeight;
  return 'ok';
" >/dev/null
sleep 0.3

window_activate
sleep 0.3

log "recording → $TMP_DIR/$NAME.mov"
record_start "$NAME"

# Hold: plan card visible (collapsed, with 'View plan' button)
sleep 2.0

log "clicking 'View plan' to expand"
eval_js "
  const btn = Array.from(document.querySelectorAll('button')).find(b => /View plan/i.test(b.textContent));
  if (!btn) throw new Error('View plan button not found');
  btn.click();
  return 'expanded';
" >/dev/null

# Poll briefly until expanded content renders (readPlanFile is async)
sleep 0.8
eval_js "
  // Wait up to 3s for plan content to show up
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const content = document.querySelector('[class*=\"planContent\"]');
    if (content && content.textContent.length > 100) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return 'rendered';
" >/dev/null

# Hold the expanded plan view for 6s so viewers can read
sleep 3.0

log "scrolling the expanded plan slowly"
eval_js "
  const content = document.querySelector('[class*=\"planContent\"]');
  if (content) {
    // Find scrollable parent (the messages container)
    const scroller = document.querySelector('[class*=\"messages_\"]');
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }
  return 'scrolled';
" >/dev/null
sleep 3.0

log "approving plan"
eval_js "
  await window.__CLAUDETTE_INVOKE__('submit_plan_approval', {
    workspaceId: '$WS_ID',
    toolUseId: '$TOOL_USE_ID',
    approved: true,
    reason: null,
  });
  const s = window.__CLAUDETTE_STORE__.getState();
  s.clearPlanApproval('$WS_ID');
  s.setPlanMode('$WS_ID', false);
  return 'approved';
"

# Record 3.5s of the transition into implementation
sleep 3.5

record_stop "$NAME"

log "encoding → $TMP_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$TMP_DIR/$NAME.mp4"
ls -lah "$TMP_DIR/$NAME.mp4"
