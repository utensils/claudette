#!/usr/bin/env bash
# latentforge-plan-approval — polls for planApprovals[wsId], records a brief
# clip showing the plan card, then submits the approval. Output: .mov + .mp4
# in $TMP_DIR. Exits non-zero if no plan arrives within $TIMEOUT.

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

NAME="latentforge-plan-approval"
WS_ID="$(cat "$TMP_DIR/lf-workspace-id")"
TIMEOUT="${TIMEOUT:-600}"   # seconds to wait for plan

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
      planFilePath: p ? p.planFilePath : null,
      agentStatus: ws?.agent_status,
      toolCount: (s.toolActivities['$WS_ID'] || []).length,
      streamLen: (s.streamingContent['$WS_ID'] || '').length,
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
    echo "last state: $result" >&2
    exit 1
  fi
  sleep 4
done

# Extract tool_use id for submission
TOOL_USE_ID=$(echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["toolUseId"])')
log "toolUseId=$TOOL_USE_ID"

log "recording → $TMP_DIR/$NAME.mov"
window_activate
sleep 0.4
record_start "$NAME"

# Hold the plan card in view for a moment
sleep 3.2

log "clicking View plan to expand"
eval_js "
  const btn = Array.from(document.querySelectorAll('button')).find(b => /View plan/i.test(b.textContent));
  if (btn) btn.click();
  return btn ? 'expanded' : 'no-view-plan-button';
" >/dev/null || true
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

# Record the agent transitioning into implementation
sleep 4.5

record_stop "$NAME"

log "encoding → $TMP_DIR/$NAME.mp4"
encode_mp4 "$TMP_DIR/$NAME.mov" "$TMP_DIR/$NAME.mp4"
ls -lah "$TMP_DIR/$NAME.mp4"
