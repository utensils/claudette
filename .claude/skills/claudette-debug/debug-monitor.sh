#!/usr/bin/env bash
# Long-running session monitor — polls the Claudette debug server and logs state changes.
# Usage: ./debug-monitor.sh [--expr 'JS'] [--interval N] [--max N] [--logfile PATH]
#
# Writes to stdout AND a log file. Only prints when state changes (dedup).
# Designed to run via `run_in_background: true` from Claude Code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EVAL_SCRIPT="${SCRIPT_DIR}/debug-eval.sh"

# Defaults
INTERVAL=1
MAX_ITER=3600  # 1 hour at 1s interval
LOGFILE="/tmp/claudette-debug/monitor.log"

# Default JS expression: comprehensive session state
JS_EXPR='const s=window.__CLAUDETTE_STORE__.getState();const w=s.selectedWorkspaceId;const acts=s.toolActivities[w]||[];const completedTurns=(s.completedTurns[w]||[]).length;const agentStatus=s.workspaces.find(x=>x.id===w)?.agent_status||"unknown";const c=document.querySelector("[class*=messages_]");const scrollGap=c?Math.round(c.scrollHeight-c.scrollTop-c.clientHeight):-1;const messageCount=(s.chatMessages[w]||[]).length;const last=acts[acts.length-1];const inputJsonValid=last?.inputJson?((()=>{try{JSON.parse(last.inputJson);return true}catch{return false}})()):null;const streaming=(s.streamingContent[w]||"").length>0;const thinking=(s.streamingThinking[w]||"").length;const thinkingEnabled=s.thinkingEnabled[w]||false;const showThinking=s.showThinkingBlocks[w]===true;return JSON.stringify({toolCount:acts.length,completedTurns,agentStatus,scrollGap,messageCount,lastToolSummary:last?.summary?.substring(0,60)||"",inputJsonValid,streaming,thinking,thinkingEnabled,showThinking})'

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expr)    JS_EXPR="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --max)     MAX_ITER="$2"; shift 2 ;;
    --logfile) LOGFILE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$(dirname "$LOGFILE")"

echo "=== Monitor started $(date -Iseconds) ===" | tee -a "$LOGFILE"
echo "=== Polling every ${INTERVAL}s, max ${MAX_ITER} iterations ===" | tee -a "$LOGFILE"
echo "=== Log: ${LOGFILE} ===" | tee -a "$LOGFILE"

prev=""
for i in $(seq 1 "$MAX_ITER"); do
  result=$("$EVAL_SCRIPT" "$JS_EXPR" 2>/dev/null) || true
  if [[ -n "$result" && "$result" != "$prev" ]]; then
    line="[$(date +%H:%M:%S) #${i}] ${result}"
    echo "$line" | tee -a "$LOGFILE"
    prev="$result"
  fi
  sleep "$INTERVAL"
done

echo "=== Monitor ended $(date -Iseconds) ===" | tee -a "$LOGFILE"
