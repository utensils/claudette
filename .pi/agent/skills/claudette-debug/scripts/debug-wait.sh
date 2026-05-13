#!/usr/bin/env bash
# Poll until the agent goes idle, then return a summary JSON.
# Usage: ./debug-wait.sh [--timeout 600] [--interval 2] [--workspace ID]
#
# Designed for `run_in_background: true` from Claude Code.
# Exit 0 when idle, exit 1 on timeout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EVAL_SCRIPT="${SCRIPT_DIR}/debug-eval.sh"

TIMEOUT=600
INTERVAL=2
WORKSPACE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)   TIMEOUT="$2"; shift 2 ;;
    --interval)  INTERVAL="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

iterations=$((TIMEOUT / INTERVAL))
start_ts=$(date +%s)

# Build the workspace selector — use provided ID or fall back to selectedWorkspaceId.
if [[ -n "$WORKSPACE" ]]; then
  WS_SELECTOR="const wsId = '$WORKSPACE';"
else
  WS_SELECTOR="const wsId = s.selectedWorkspaceId; if (!wsId) return JSON.stringify({error:'no workspace selected'});"
fi

# The running check uses multiple signals because agent_status in the store may
# not reflect "Running" when the message was sent via the debug eval API (which
# bypasses the ChatPanel React handler).  We treat the agent as running when ANY
# of these are true: store says "Running", streaming content is accumulating,
# tool activities exist, or thinking content is present.
JS_CHECK="const s=window.__CLAUDETTE_STORE__.getState();${WS_SELECTOR}const ws=s.workspaces.find(x=>x.id===wsId);const acts=s.toolActivities[wsId]||[];const stream=(s.streamingContent[wsId]||'');const thinking=(s.streamingThinking[wsId]||'');const msgs=(s.chatMessages[wsId]||[]);const turns=(s.completedTurns[wsId]||[]);const last=acts[acts.length-1];const running=ws?.agent_status==='Running'||stream.length>0||acts.length>0||thinking.length>0;if(running){return JSON.stringify({running:true,agentStatus:ws?.agent_status,messageCount:msgs.length,toolCount:acts.length,streamingLength:stream.length,lastTool:last?.toolName,lastToolSummary:last?.summary?.substring(0,60)})}const elapsed=Math.round((Date.now()/1000)-${start_ts});const lastTurn=turns[turns.length-1];return JSON.stringify({running:false,agentStatus:ws?.agent_status,messageCount:msgs.length,completedTurns:turns.length,lastTurnTools:lastTurn?lastTurn.activities.length:0,lastToolSummary:lastTurn?.activities[lastTurn.activities.length-1]?.summary?.substring(0,80),durationSeconds:elapsed})"

# Track whether we've ever seen the agent in a running state.  If not, we give
# a grace period (up to GRACE_POLLS) for the agent process to start and begin
# streaming before concluding it is idle.
GRACE_POLLS=$(( 5 > (TIMEOUT / INTERVAL) ? (TIMEOUT / INTERVAL) : 5 ))
seen_running=false

for i in $(seq 1 "$iterations"); do
  result=$("$EVAL_SCRIPT" "$JS_CHECK" 2>/dev/null) || true
  if [[ -n "$result" ]]; then
    # Check for error
    if echo "$result" | grep -q '"error"'; then
      echo "$result"
      exit 1
    fi
    # Check if running
    if echo "$result" | grep -q '"running":true'; then
      seen_running=true
    fi
    # Only report idle if we've seen it running at least once, OR we've
    # exhausted the grace period (agent never started).
    if echo "$result" | grep -q '"running":false'; then
      if $seen_running || [[ $i -gt $GRACE_POLLS ]]; then
        echo "$result"
        exit 0
      fi
    fi
  fi
  sleep "$INTERVAL"
done

echo "{\"error\":\"timeout after ${TIMEOUT}s\"}"
exit 1
